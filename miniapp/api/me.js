const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const USERS_DATA_SOURCE_ID = "699ad636-991e-4325-a2e4-0c1d8bfd0335";
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

async function findUser(token, telegramId) {
    const data = await notionRequest(
        token,
        `/data_sources/${USERS_DATA_SOURCE_ID}/query`,
        {
            method: "POST",
            body: JSON.stringify({
                page_size: 1,
                filter: {
                    property: "Telegram ID",
                    rich_text: { equals: telegramId },
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

    const auth = validateTelegramInitData(req.body?.initData, botToken);

    if (!auth.valid) {
        return res.status(401).json({ code: "AUTH_FAILED", error: "Telegram authorization failed" });
    }

    try {
        const userPage = await findUser(notionToken, String(auth.user.id));
        const role = userPage?.properties?.Role?.select?.name || "reader";

        return res.status(200).json({
            role,
            isAdmin: role === "admin",
        });
    } catch (error) {
        console.error("Failed to load current user role", error);
        return res.status(502).json({
            code: "NOTION_ERROR",
            error: "Не удалось загрузить роль пользователя",
            notionStatus: error?.status || null,
        });
    }
};
