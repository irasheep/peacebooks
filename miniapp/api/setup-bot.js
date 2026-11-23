const crypto = require("crypto");

const APP_URL = process.env.APP_URL || "https://peacebooks-mu.vercel.app";

function webhookSecret(botToken) {
    return crypto
        .createHash("sha256")
        .update(`peacebooks-webhook:${botToken}`, "utf8")
        .digest("hex");
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

module.exports = async function handler(req, res) {
    if (!["GET", "POST"].includes(req.method)) {
        return res.status(405).json({ ok: false });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
        return res.status(500).json({
            ok: false,
            error: "TELEGRAM_BOT_TOKEN is missing",
        });
    }

    const webhookUrl = `${APP_URL}/api/telegram-webhook`;
    const secretToken = webhookSecret(botToken);

    try {
        await telegramRequest(botToken, "setWebhook", {
            url: webhookUrl,
            secret_token: secretToken,
            allowed_updates: ["message"],
            drop_pending_updates: true,
        });

        await telegramRequest(botToken, "setMyCommands", {
            commands: [
                {
                    command: "start",
                    description: "Открыть Книги Мира",
                },
                {
                    command: "howmuch",
                    description: "Когда возвращать книгу",
                },
            ],
        });

        await telegramRequest(botToken, "setChatMenuButton", {
            menu_button: {
                type: "web_app",
                text: "Библиотека",
                web_app: { url: APP_URL },
            },
        });

        const info = await telegramRequest(botToken, "getWebhookInfo", {});

        return res.status(200).json({
            ok: true,
            webhook: info.url,
            pendingUpdates: info.pending_update_count,
            menuButton: "Библиотека",
        });
    } catch (error) {
        console.error("Bot setup failed", error);

        return res.status(500).json({
            ok: false,
            error: error.message,
        });
    }
};
