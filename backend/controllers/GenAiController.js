
const Invoice = require("../models/Invoice");
const { OpenAI } = require("openai");
const { GoogleGenAI } = require("@google/genai");

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const callAiWithFallback = async (prompt, systemPrompt = "You extract invoice data and output JSON only.") => {
  let responseText = "";

  // 1. Try Gemini first (working with user's key)
  if (ai) {
    const geminiModels = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest"];
    for (const model of geminiModels) {
      try {
        const result = await ai.models.generateContent({
          model,
          contents: (systemPrompt ? systemPrompt + "\n\n" : "") + prompt,
        });
        if (result && result.text) {
          responseText = result.text;
          break;
        }
      } catch (err) {
        console.warn(`Gemini model ${model} attempt:`, err.message);
      }
    }
  }

  // 2. Try OpenAI if Gemini didn't return text
  if (!responseText && openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 500,
      });
      responseText = completion?.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.warn("OpenAI attempt failed:", err.message);
    }
  }

  return responseText;
};

// Fallback extractor using regex in case both AI services are unavailable
const fallbackExtractFromText = (text) => {
  const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
  const email = emailMatch ? emailMatch[0] : "";

  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const phone = phoneMatch ? phoneMatch[0] : "";

  let clientName = "";
  const nameMatch = text.match(/(?:client|for|to|customer|bill to)[:\s]+([A-Za-z0-9\s]+?)(?:,|\n|\.|$)/i);
  if (nameMatch) {
    clientName = nameMatch[1].trim();
  }

  const items = [];
  const lines = text.split(/\r?\n|;/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const priceMatch = trimmed.match(/(?:₹|\$|INR|USD)?\s*(\d+(?:\.\d{1,2})?)/);
    const qtyMatch = trimmed.match(/(\d+)\s*(?:hrs?|hours?|items?|units?|x|pcs?)?/i);
    if (priceMatch) {
      const cleanName = trimmed.replace(/(?:₹|\$|INR|USD|\d+)/g, "").replace(/[@x,-]/g, "").trim();
      items.push({
        name: cleanName || "Service / Product",
        quantity: qtyMatch ? parseInt(qtyMatch[1], 10) || 1 : 1,
        unitPrice: priceMatch ? parseFloat(priceMatch[1]) || 0 : 0,
      });
    }
  }

  return {
    clientName: clientName || "Client",
    email,
    phone,
    address: "",
    items: items.length > 0 ? items : [{ name: "Consulting / Service", quantity: 1, unitPrice: 100 }],
  };
};

exports.InvoiceFromText = async (req, res) => {
  try {
    const { text } = req.body;

    // 1️⃣ Validate input
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ message: "Text is required" });
    }

    // 2️⃣ Limit input size
    const safeText = text.slice(0, 2000);

    const prompt = `
You are a strict invoice data extraction engine.

YOUR TASK:
Extract CLIENT (billTo) information and invoice items from the given text.

ABSOLUTE RULES (NO EXCEPTIONS):
1. You MUST return ALL keys exactly as defined below.
2. NEVER skip email, phone, or address keys.
3. If a value is not found, return an empty string "".
4. Client details ALWAYS belong to billTo.
5. Do NOT assume business/seller/billFrom details unless explicitly mentioned.
6. Do NOT rename keys.
7. Return ONLY valid JSON. No explanations. No markdown.

JSON SCHEMA (MUST FOLLOW EXACTLY):
{
  "clientName": "",
  "email": "",
  "phone": "",
  "address": "",
  "items": [
    {
      "name": "",
      "quantity": 1,
      "unitPrice": 0
    }
  ]
}

EXTRACTION HINTS:
- Client Name is a company or person's full name.
- Email contains "@".
- Phone is a contact number.
- Address is a location.
- Items are products or services with quantity and price.

TEXT TO ANALYZE:
${safeText}

RETURN JSON ONLY.
`;

    // 3️⃣ Call AI with multi-model failover
    const responseText = await callAiWithFallback(prompt);

    if (responseText) {
      const cleanedText = responseText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      try {
        const parsedData = JSON.parse(cleanedText);
        return res.status(200).json({
          clientName: parsedData.clientName || "",
          email: parsedData.email || "",
          phone: parsedData.phone || "",
          address: parsedData.address || "",
          items: Array.isArray(parsedData.items) && parsedData.items.length > 0
            ? parsedData.items.map(item => ({
                name: item.name || "Item",
                quantity: Number(item.quantity) || 1,
                unitPrice: Number(item.unitPrice) || 0,
                taxPercent: Number(item.taxPercent) || 0,
              }))
            : [],
        });
      } catch (err) {
        console.warn("JSON Parse Error on AI output, falling back to heuristic parsing:", err.message);
      }
    }

    // Fallback to heuristic parser on user's actual text
    const fallbackData = fallbackExtractFromText(safeText);
    return res.status(200).json(fallbackData);

  } catch (error) {
    console.error("InvoiceFromText AI Error:", error);
    const fallbackData = fallbackExtractFromText(req.body.text || "");
    return res.status(200).json(fallbackData);
  }
};

exports.sendPaymentReminder = async (req, res) => {
  try {
    const { invoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ message: "Invoice data is required" });
    }

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const clientName = invoice.billTo?.clientName || "Valued Client";
    const amountDue = (invoice.total || 0).toFixed(2);
    const dueDateStr = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "Upon Receipt";

    const prompt = `
You are a professional and polite accounting assistant.
Write a friendly reminder email to a client.

Use the following details to personalize the email:
- Client Name: ${clientName}
- Invoice Number: ${invoice.invoiceNumber}
- Amount Due: ₹${amountDue}
- Due Date: ${dueDateStr}

The tone should be friendly but clear.
Keep it concise.
Start the email with "Subject:".
`;

    let reminderText = "";

    if (ai) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: prompt,
        });
        reminderText = response.text;
      } catch (geminiErr) {
        console.warn("Gemini generation failed, trying fallback:", geminiErr.message);
      }
    }

    if (!reminderText && openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a professional accounting assistant." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 300,
        });
        reminderText = completion?.choices?.[0]?.message?.content || "";
      } catch (openAiErr) {
        console.warn("OpenAI reminder generation failed:", openAiErr.message);
      }
    }

    if (!reminderText) {
      reminderText = `Subject: Friendly Reminder: Invoice #${invoice.invoiceNumber} Payment Due\n\nDear ${clientName},\n\nWe hope this email finds you well. This is a gentle reminder that invoice #${invoice.invoiceNumber} for the amount of ₹${amountDue} is due on ${dueDateStr}.\n\nPlease let us know once the payment has been initiated, or if you have any questions.\n\nThank you for your business!\n\nBest regards,\n${invoice.billFrom?.businessName || "Accounts Team"}`;
    }

    res.status(200).json({ reminderText });
  } catch (error) {
    console.error("Generate Reminder Error:", error);
    res.status(500).json({
      message: "Failed to generate reminder email",
      error: error.message,
    });
  }
};

exports.getDashboardSummary = async (req, res) => {
  try {
    const invoices = await Invoice.find({ user: req.user._id });

    if (!invoices || invoices.length === 0) {
      return res.status(200).json({
        summary: {
          totalInvoices: 0,
          paidInvoices: 0,
          unpaidInvoices: 0,
          totalRevenue: "0.00",
          totalOutstanding: "0.00",
        },
        insights: [
          "Welcome to InvoiceAI! Create your first invoice to unlock automated AI financial insights.",
          "Track paid and pending payments in real time.",
          "Use the 'Create with AI' button to convert raw text into structured invoices instantly."
        ]
      });
    }

    // Prepare summary data
    const totalInvoices = invoices.length;
    const paidInvoices = invoices.filter((inv) => (inv.status || "").toLowerCase() === "paid");
    const unpaidInvoices = invoices.filter((inv) => (inv.status || "").toLowerCase() !== "paid");

    const totalRevenue = paidInvoices.reduce(
      (acc, inv) => acc + (inv.total || 0),
      0
    );
    const totalOutstanding = unpaidInvoices.reduce(
      (acc, inv) => acc + (inv.total || 0),
      0
    );

    const recentInvoices = invoices
      .slice(0, 5)
      .map(
        (inv) =>
          `#${inv.invoiceNumber} ₹${(inv.total || 0).toFixed(2)} (${inv.status || "UnPaid"})`
      )
      .join(", ");

    const defaultInsights = [
      `You have ${unpaidInvoices.length} unpaid invoice(s) totaling ₹${totalOutstanding.toFixed(2)}.`,
      `Total collected revenue currently stands at ₹${totalRevenue.toFixed(2)}.`,
      `Your collection rate is ${totalInvoices > 0 ? ((paidInvoices.length / totalInvoices) * 100).toFixed(0) : 0}% of all invoices.`
    ];

    let insights = defaultInsights;

    if (openai || ai) {
      try {
        const prompt = `
You are a friendly, practical financial assistant. Based on this summary, give 3 clear insights:

- Total invoices: ${totalInvoices}
- Paid invoices: ${paidInvoices.length}
- Unpaid invoices: ${unpaidInvoices.length}
- Revenue: ₹${totalRevenue.toFixed(2)}
- Outstanding: ₹${totalOutstanding.toFixed(2)}
- Recent: ${recentInvoices}

Return JSON ONLY in this format:
{
  "insights": ["Insight 1", "Insight 2", "Insight 3"]
}
        `;

        if (ai) {
          try {
            const result = await ai.models.generateContent({
              model: "gemini-3.5-flash",
              contents: prompt,
            });
            text = result.text || "";
          } catch (geminiErr) {
            console.warn("Gemini dashboard summary failed:", geminiErr.message);
          }
        }

        if (!text && openai) {
          try {
            const response = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "You are a helpful financial assistant." },
                { role: "user", content: prompt },
              ],
              temperature: 0.7,
              max_tokens: 300,
            });
            text = response.choices?.[0]?.message?.content || "";
          } catch (openAiErr) {
            console.warn("OpenAI dashboard summary failed:", openAiErr.message);
          }
        }

        const cleaned = text
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed.insights) && parsed.insights.length > 0) {
          insights = parsed.insights;
        }
      } catch (aiErr) {
        console.warn("AI Insights generation fallback used:", aiErr.message);
      }
    }

    res.status(200).json({
      summary: {
        totalInvoices,
        paidInvoices: paidInvoices.length,
        unpaidInvoices: unpaidInvoices.length,
        totalRevenue: totalRevenue.toFixed(2),
        totalOutstanding: totalOutstanding.toFixed(2),
      },
      insights,
    });
  } catch (error) {
    console.error("Dashboard Summary Error:", error);
    res.status(500).json({ message: "Failed", error: error.message });
  }
};
