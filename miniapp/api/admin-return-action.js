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

function richTextValue(property) {
    return (property?.rich_text || [])
        .map((item) => item.plain_text || item.text?.content || "")
        .join("")
        .trim();
}

async function isAdmin(token, telegramId) {
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

    return data.results?.[0]?.properties?.Role?.select?.name === "admin";
}

async function updateLoan(token, loanId, properties) {
    return notionRequest(token, `/pages/${encodeURIComponent(loanId)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
    });
}

async function updateBookStatus(token, bookId, status) {
    return notionRequest(token, `/pages/${encodeURIComponent(bookId)}`, {
        method: "PATCH",
        body: JSON.stringify({
            properties: {
                Status: { status: { name: status } },
            },
        }),
    });
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

    const loanId = typeof req.body?.loanId === "string" ? req.body.loanId : "";
    const action = req.body?.action;

    if (!loanId || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ code: "BAD_REQUEST", error: "loanId and valid action are required" });
    }

    try {
        if (!(await isAdmin(notionToken, String(auth.user.id)))) {
            return res.status(403).json({ code: "FORBIDDEN", error: "Admin access required" });
        }

        const loan = await notionRequest(
            notionToken,
            `/pages/${encodeURIComponent(loanId)}`,
            { method: "GET" }
        );

        if (loan.properties?.Status?.select?.name !== "return_pending") {
            return res.status(409).json({
                code: "NOT_PENDING",
                error: "Return is no longer pending",
            });
        }

        if (action === "reject") {
            await updateLoan(notionToken, loanId, {
                Status: { select: { name: "active" } },
                "Return Requested At": { date: null },
                "Return Photo": { files: [] },
            });

            return res.status(200).json({ ok: true, status: "active" });
        }

        const bookId = richTextValue(loan.properties?.["Book Page ID"]);

        if (!bookId) {
            return res.status(409).json({
                code: "BOOK_ID_MISSING",
                error: "Loan has no Book Page ID",
            });
        }

        const returnedAt = new Date().toISOString();

        await updateLoan(notionToken, loanId, {
            Status: { select: { name: "returned" } },
            "Returned At": { date: { start: returnedAt } },
        });

        try {
            await updateBookStatus(notionToken, bookId, "На полке");
        } catch (error) {
            try {
                await updateLoan(notionToken, loanId, {
                    Status: { select: { name: "return_pending" } },
                    "Returned At": { date: null },
                });
            } catch (rollbackError) {
                console.error("Failed to roll back approved return", rollbackError);
            }

            throw error;
        }

        return res.status(200).json({
            ok: true,
            status: "returned",
            returnedAt,
        });
    } catch (error) {
        console.error("Admin return action failed", error);

        return res.status(502).json({
            code: "NOTION_ERROR",
            error: "Не удалось обработать возврат",
            notionStatus: error?.status || null,
        });
    }
};
