const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const BOOKS_DATA_SOURCE_ID = "3e496b5b-b336-80dd-84bb-000bd8ec8192";
const USERS_DATA_SOURCE_ID = "699ad636-991e-4325-a2e4-0c1d8bfd0335";
const LOANS_DATA_SOURCE_ID = "05e6acc7-f747-4fa1-af9c-affdbf2c3f28";
const MIR_QR_SHA256 = "447db8c1666b435bc74f0c46f94beb4d35fc9cb607c2ef51d0faca92d3f535f2";
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function safeEqual(a, b) {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");

    if (left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

function validateQr(qrText) {
    const hash = crypto.createHash("sha256").update(qrText.trim(), "utf8").digest("hex");
    return safeEqual(hash, MIR_QR_SHA256);
}

function validateTelegramInitData(initData, botToken) {
    if (!initData || !botToken) {
        return { valid: false, reason: "missing_config" };
    }

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) {
        return { valid: false, reason: "missing_hash" };
    }

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

    if (!safeEqual(receivedHash, calculatedHash)) {
        return { valid: false, reason: "bad_hash" };
    }

    const authDate = Number(params.get("auth_date"));

    if (!Number.isFinite(authDate)) {
        return { valid: false, reason: "missing_auth_date" };
    }

    const age = Math.floor(Date.now() / 1000) - authDate;

    if (age < 0 || age > INIT_DATA_MAX_AGE_SECONDS) {
        return { valid: false, reason: "expired" };
    }

    const rawUser = params.get("user");

    if (!rawUser) {
        return { valid: false, reason: "missing_user" };
    }

    try {
        const user = JSON.parse(rawUser);

        if (!user?.id) {
            return { valid: false, reason: "missing_user_id" };
        }

        return { valid: true, user };
    } catch {
        return { valid: false, reason: "bad_user" };
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

function plainTitle(property) {
    return (property?.title || [])
        .map((item) => item.plain_text || item.text?.content || "")
        .join("")
        .trim();
}

function richText(content) {
    return {
        rich_text: content
            ? [{ type: "text", text: { content: String(content) } }]
            : [],
    };
}

function title(content) {
    return {
        title: [{ type: "text", text: { content: String(content) } }],
    };
}

async function findUserPage(token, telegramId) {
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

async function ensureUser(token, user) {
    const telegramId = String(user.id);
    const existing = await findUserPage(token, telegramId);
    const displayName =
        [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
        (user.username ? `@${user.username}` : `Telegram ${telegramId}`);

    const properties = {
        User: title(displayName),
        "Telegram ID": richText(telegramId),
        Username: richText(user.username || ""),
        "First Name": richText(user.first_name || ""),
        "Last Name": richText(user.last_name || ""),
    };

    if (existing) {
        await notionRequest(token, `/pages/${existing.id}`, {
            method: "PATCH",
            body: JSON.stringify({ properties }),
        });
        return existing.id;
    }

    const created = await notionRequest(token, "/pages", {
        method: "POST",
        body: JSON.stringify({
            parent: {
                type: "data_source_id",
                data_source_id: USERS_DATA_SOURCE_ID,
            },
            properties: {
                ...properties,
                Role: { select: { name: "reader" } },
            },
        }),
    });

    return created.id;
}

async function findActiveLoan(token, telegramId) {
    const data = await notionRequest(
        token,
        `/data_sources/${LOANS_DATA_SOURCE_ID}/query`,
        {
            method: "POST",
            body: JSON.stringify({
                page_size: 1,
                filter: {
                    and: [
                        {
                            property: "Telegram ID",
                            rich_text: { equals: telegramId },
                        },
                        {
                            or: [
                                {
                                    property: "Status",
                                    select: { equals: "active" },
                                },
                                {
                                    property: "Status",
                                    select: { equals: "return_pending" },
                                },
                            ],
                        },
                    ],
                },
            }),
        }
    );

    return data.results?.[0] || null;
}

async function getBook(token, bookId) {
    return notionRequest(token, `/pages/${encodeURIComponent(bookId)}`, {
        method: "GET",
    });
}

async function setBookStatus(token, bookId, status) {
    return notionRequest(token, `/pages/${encodeURIComponent(bookId)}`, {
        method: "PATCH",
        body: JSON.stringify({
            properties: {
                Status: {
                    status: { name: status },
                },
            },
        }),
    });
}

async function createLoan(token, user, book, borrowedAt, dueAt) {
    const telegramId = String(user.id);
    const bookTitle = plainTitle(book.properties?.["Book Name"]) || "Книга";
    const borrowerName =
        [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
        user.username ||
        telegramId;

    return notionRequest(token, "/pages", {
        method: "POST",
        body: JSON.stringify({
            parent: {
                type: "data_source_id",
                data_source_id: LOANS_DATA_SOURCE_ID,
            },
            properties: {
                Loan: title(`${bookTitle} — ${borrowerName}`),
                "Telegram ID": richText(telegramId),
                "Book Page ID": richText(book.id),
                "Book Title": richText(bookTitle),
                Status: { select: { name: "active" } },
                "Borrowed At": { date: { start: borrowedAt } },
                "Due At": { date: { start: dueAt } },
                Extended: { checkbox: false },
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
        return res.status(500).json({
            code: "CONFIG_ERROR",
            error: "Server configuration is incomplete",
        });
    }

    let body = req.body;

    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return res.status(400).json({ code: "BAD_REQUEST", error: "Invalid JSON" });
        }
    }

    const initData = typeof body?.initData === "string" ? body.initData : "";
    const qrText = typeof body?.qrText === "string" ? body.qrText : "";
    const bookId = typeof body?.bookId === "string" ? body.bookId : "";

    if (!qrText || !bookId || !initData) {
        return res.status(400).json({
            code: "BAD_REQUEST",
            error: "initData, qrText and bookId are required",
        });
    }

    const auth = validateTelegramInitData(initData, botToken);

    if (!auth.valid) {
        return res.status(401).json({
            code: "AUTH_FAILED",
            error: "Telegram authorization failed",
        });
    }

    if (!validateQr(qrText)) {
        return res.status(403).json({
            code: "WRONG_QR",
            error: "Wrong MIR QR",
        });
    }

    const telegramId = String(auth.user.id);
    let stage = "start";

    try {
        stage = "check_active_loan";
        const activeLoan = await findActiveLoan(notionToken, telegramId);

        if (activeLoan) {
            return res.status(409).json({
                code: "ACTIVE_LOAN",
                error: "User already has an active loan",
            });
        }

        stage = "get_book";
        const book = await getBook(notionToken, bookId);
        const bookStatus = book.properties?.Status?.status?.name;

        if (bookStatus !== "На полке") {
            return res.status(409).json({
                code: "BOOK_UNAVAILABLE",
                error: "Book is not available",
            });
        }

        stage = "ensure_user";
        await ensureUser(notionToken, auth.user);

        const borrowedAt = new Date();
        const dueAt = new Date(borrowedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

        stage = "set_book_status";
        await setBookStatus(notionToken, bookId, "На руках");

        try {
            stage = "create_loan";
            const loan = await createLoan(
                notionToken,
                auth.user,
                book,
                borrowedAt.toISOString(),
                dueAt.toISOString()
            );

            return res.status(201).json({
                ok: true,
                loanId: loan.id,
                bookId,
                dueAt: dueAt.toISOString(),
            });
        } catch (error) {
            try {
                await setBookStatus(notionToken, bookId, "На полке");
            } catch (rollbackError) {
                console.error("Failed to roll back book status", rollbackError);
            }

            throw error;
        }
    } catch (error) {
        console.error("Borrow failed", error);

        return res.status(502).json({
            code: "NOTION_ERROR",
            error: "Не удалось оформить выдачу",
            stage,
            notionStatus: error?.status || null,
        });
    }
};
