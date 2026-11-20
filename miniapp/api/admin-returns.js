const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const USERS_DATA_SOURCE_ID = "699ad636-991e-4325-a2e4-0c1d8bfd0335";
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

function titleValue(property) {
    return (property?.title || [])
        .map((item) => item.plain_text || item.text?.content || "")
        .join("")
        .trim();
}

function photoUrl(property) {
    const file = property?.files?.[0];
    if (!file) return null;

    if (file.type === "file") return file.file?.url || null;
    if (file.type === "external") return file.external?.url || null;

    return null;
}

async function findAdmin(token, telegramId) {
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

    const user = data.results?.[0] || null;

    if (user?.properties?.Role?.select?.name !== "admin") {
        return null;
    }

    return user;
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
        const admin = await findAdmin(notionToken, String(auth.user.id));

        if (!admin) {
            return res.status(403).json({ code: "FORBIDDEN", error: "Admin access required" });
        }

        const data = await notionRequest(
            notionToken,
            `/data_sources/${LOANS_DATA_SOURCE_ID}/query`,
            {
                method: "POST",
                body: JSON.stringify({
                    page_size: 50,
                    sorts: [{ property: "Return Requested At", direction: "ascending" }],
                    filter: {
                        property: "Status",
                        select: { equals: "return_pending" },
                    },
                }),
            }
        );

        const userCache = new Map();

        const returns = await Promise.all(
            (data.results || []).map(async (loan) => {
                const telegramId = richTextValue(loan.properties?.["Telegram ID"]);

                let user = userCache.get(telegramId);

                if (user === undefined) {
                    user = telegramId ? await findUser(notionToken, telegramId) : null;
                    userCache.set(telegramId, user);
                }

                const userName =
                    titleValue(user?.properties?.User) ||
                    [richTextValue(user?.properties?.["First Name"]), richTextValue(user?.properties?.["Last Name"])]
                        .filter(Boolean)
                        .join(" ") ||
                    (telegramId ? `Telegram ${telegramId}` : "Неизвестный читатель");

                return {
                    id: loan.id,
                    bookTitle: richTextValue(loan.properties?.["Book Title"]) || "Книга",
                    userName,
                    telegramId,
                    photoUrl: photoUrl(loan.properties?.["Return Photo"]),
                    requestedAt: loan.properties?.["Return Requested At"]?.date?.start || null,
                };
            })
        );

        return res.status(200).json({ returns });
    } catch (error) {
        console.error("Failed to load admin returns", error);
        return res.status(502).json({
            code: "NOTION_ERROR",
            error: "Не удалось загрузить возвраты",
            notionStatus: error?.status || null,
        });
    }
};
