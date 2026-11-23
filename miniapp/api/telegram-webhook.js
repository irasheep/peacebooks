const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const USERS_DATA_SOURCE_ID = "699ad636-991e-4325-a2e4-0c1d8bfd0335";
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
        "Привет! Это «Книги Мира» 📚",
        "",
        "Небольшая библиотека на полке кофейни МИР.",
        "",
        "Сейчас в коллекции около 20 книг, а состав полки меняется сезонно — так что время от времени здесь будет появляться что-то новое.",
        "",
        "В приложении можно посмотреть каталог, взять одну книгу на 30 дней и вернуть её обратно на полку.",
        "",
        "Есть книга, которую обязательно стоит добавить? Пиши @irsheep 💌",
        "",
        "Открывай библиотеку ↓",
    ].join("\n");

    return telegramRequest(botToken, "sendMessage", {
        chat_id: chatId,
        text,
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
        }

        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error("Telegram webhook failed", error);
        return res.status(200).json({ ok: true });
    }
};
