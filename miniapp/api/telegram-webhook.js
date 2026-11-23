const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const USERS_DATA_SOURCE_ID = "699ad636-991e-4325-a2e4-0c1d8bfd0335";
const LOANS_DATA_SOURCE_ID = "05e6acc7-f747-4fa1-af9c-affdbf2c3f28";
const APP_URL = process.env.APP_URL || "https://peacebooks-mu.vercel.app";

function webhookSecret(botToken) {
    return crypto
        .createHash("sha256")
        .update(`peacebooks-webhook:${botToken}`, "utf8")
        .digest("hex");
}

function safeEqual(a, b) {
    const left = Buffer.from(a || "", "utf8");
    const right = Buffer.from(b || "", "utf8");
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

async function telegramRequest(botToken, method, body) {
    const response = await fetch(
        `https://api.telegram.org/bot${botToken}/${method}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
    }

    return data.result;
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
        throw new Error(`Notion API ${response.status}: ${detail}`);
    }

    return response.json();
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

function datePartsInBelgrade(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Belgrade",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const values = Object.fromEntries(
        parts
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value])
    );

    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
    };
}

function parseDueDate(dueAt) {
    const match = String(dueAt || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;

    return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
    };
}

function calendarDaysUntil(dueAt) {
    const due = parseDueDate(dueAt);
    if (!due) return null;

    const today = datePartsInBelgrade();
    const dueUtc = Date.UTC(due.year, due.month - 1, due.day);
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);

    return Math.round((dueUtc - todayUtc) / 86400000);
}

function formatDueDate(dueAt) {
    const due = parseDueDate(dueAt);
    if (!due) return null;

    return new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(new Date(Date.UTC(due.year, due.month - 1, due.day)));
}

function dayWord(value) {
    const n = Math.abs(value) % 100;
    const n1 = n % 10;

    if (n > 10 && n < 20) return "дней";
    if (n1 === 1) return "день";
    if (n1 >= 2 && n1 <= 4) return "дня";
    return "дней";
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

async function ensureUser(token, user) {
    const telegramId = String(user.id);
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

    const existing = await findUser(token, telegramId);

    if (existing) {
        await notionRequest(token, `/pages/${existing.id}`, {
            method: "PATCH",
            body: JSON.stringify({ properties }),
        });
        return;
    }

    await notionRequest(token, "/pages", {
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
}

async function sendStart(botToken, chatId) {
    const text = [
        'Привет! Это бот книжной полки кофейни <a href="https://share.google/sQ40k2xOwxWehjRBe">МИР</a>.',
        "",
        "В каталоге можно посмотреть то, что есть на полке в данный момент, а состав будет меняться время от времени.",
        "Книгу можно взять домой одну за раз и просим вернуть не позже, чем через 30 дней.",
        "",
        "По вопросам библиотеки можно писать Ирен @irsheep.",
    ].join("\n");

    return telegramRequest(botToken, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "📚 Открыть библиотеку",
                        web_app: { url: APP_URL },
                    },
                ],
            ],
        },
    });
}


async function sendHowMuch(botToken, notionToken, chatId, user) {
    if (!notionToken) {
        return telegramRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: "Не удалось проверить выдачу. Попробуй чуть позже.",
        });
    }

    const loan = await findCurrentLoan(notionToken, String(user.id));

    if (!loan) {
        return telegramRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: "Сейчас у тебя нет книг на руках.",
        });
    }

    const bookTitle = richTextValue(loan.properties?.["Book Title"]) || "Книгу";
    const dueAt = loan.properties?.["Due At"]?.date?.start || null;
    const dueDate = formatDueDate(dueAt);
    const daysLeft = calendarDaysUntil(dueAt);

    if (!dueDate || daysLeft === null) {
        return telegramRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: `У тебя на руках «${bookTitle}», но дату возврата сейчас не удалось определить.`,
        });
    }

    let timingText;

    if (daysLeft > 0) {
        timingText = `До возврата осталось ${daysLeft} ${dayWord(daysLeft)}.`;
    } else if (daysLeft === 0) {
        timingText = "Вернуть нужно сегодня.";
    } else {
        const overdue = Math.abs(daysLeft);
        timingText = `Срок возврата уже прошёл. Просрочка — ${overdue} ${dayWord(overdue)}.`;
    }

    return telegramRequest(botToken, "sendMessage", {
        chat_id: chatId,
        text: `«${bookTitle}» нужно вернуть до ${dueDate}.\n${timingText}`,
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ ok: false });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const notionToken = process.env.Notion_Token;

    if (!botToken) {
        return res.status(500).json({ ok: false });
    }

    const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
    const expectedSecret = webhookSecret(botToken);

    if (!safeEqual(receivedSecret, expectedSecret)) {
        return res.status(403).json({ ok: false });
    }

    const message = req.body?.message;
    const text = message?.text || "";
    const chatId = message?.chat?.id;
    const user = message?.from;

    try {
        if (
            message?.chat?.type === "private" &&
            chatId &&
            user &&
            /^\/start(?:\s|$)/.test(text)
        ) {
            if (notionToken) {
                try {
                    await ensureUser(notionToken, user);
                } catch (error) {
                    console.error("Failed to register Telegram user", error);
                }
            }

            await sendStart(botToken, chatId);
        } else if (
            message?.chat?.type === "private" &&
            chatId &&
            user &&
            /^\/howmuch(?:@\w+)?(?:\s|$)/i.test(text)
        ) {
            await sendHowMuch(botToken, notionToken, chatId, user);
        }

        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error("Telegram webhook failed", error);
        return res.status(200).json({ ok: true });
    }
};
