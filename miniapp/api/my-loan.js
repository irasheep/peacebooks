const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const LOANS_DATA_SOURCE_ID = "05e6acc7-f747-4fa1-af9c-affdbf2c3f28";
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function safeEqual(a, b) {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function validateTelegramInitData(initData, botToken) {
    if (!initData || !botToken) return { valid: false };

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    if (!receivedHash) return { valid: false };

    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();

    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (!safeEqual(receivedHash, calculatedHash)) return { valid: false };

    const authDate = Number(params.get("auth_date"));
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (!Number.isFinite(authDate) || age < 0 || age > INIT_DATA_MAX_AGE_SECONDS) {
        return { valid: false };
    }

    try {
        const user = JSON.parse(params.get("user") || "");
        if (!user?.id) return { valid: false };
        return { valid: true, user };
    } catch {
        return { valid: false };
    }
}

async function notionRequest(token, path, options = {}) {
    const response = await fetch(`https://api.notion.com/v1${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });

    if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`Notion API ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
    }

    return response.json();
}

function richTextValue(property) {
    return (property?.rich_text || [])
        .map((item) => item.plain_text || item.text?.content || "")
        .join("")
        .trim();
}

async function findCurrentLoan(token, telegramId) {
    const data = await notionRequest(
        token,
        `/data_sources/${LOANS_DATA_SOURCE_ID}/query`,
        {
            method: "POST",
            body: JSON.stringify({
                page_size: 1,
                sorts: [{ property: "Created time", direction: "descending" }],
                filter: {
                    and: [
                        {
                            property: "Telegram ID",
                            rich_text: { equals: telegramId },
                        },
                        {
                            or: [
                                { property: "Status", select: { equals: "active" } },
                                { property: "Status", select: { equals: "return_pending" } },
                            ],
                        },
                    ],
                },
            }),
        }
    );

    return data.results?.[0] || null;
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const notionToken = process.env.Notion_Token;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!notionToken || !botToken) {
        return res.status(500).json({ code: "CONFIG_ERROR", error: "Server configuration is incomplete" });
    }

    let body = req.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return res.status(400).json({ code: "BAD_REQUEST", error: "Invalid JSON" });
        }
    }

    const auth = validateTelegramInitData(body?.initData, botToken);
    if (!auth.valid) {
        return res.status(401).json({ code: "AUTH_FAILED", error: "Telegram authorization failed" });
    }

    try {
        const loan = await findCurrentLoan(notionToken, String(auth.user.id));

        if (!loan) {
            return res.status(200).json({ loan: null });
        }

        return res.status(200).json({
            loan: {
                id: loan.id,
                status: loan.properties?.Status?.select?.name || null,
                bookTitle: richTextValue(loan.properties?.["Book Title"]) || "Книга",
                dueAt: loan.properties?.["Due At"]?.date?.start || null,
            },
        });
    } catch (error) {
        console.error("Failed to load current loan", error);
        return res.status(502).json({
            code: "NOTION_ERROR",
            error: "Не удалось загрузить текущую выдачу",
            notionStatus: error?.status || null,
        });
    }
};
