const crypto = require("crypto");

const NOTION_VERSION = "2026-03-11";
const LOANS_DATA_SOURCE_ID = "05e6acc7-f747-4fa1-af9c-affdbf2c3f28";
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

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

async function notionJsonRequest(token, path, options = {}) {
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

async function findCurrentLoan(token, telegramId) {
    const data = await notionJsonRequest(
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

function parsePhoto(dataUrl) {
    if (typeof dataUrl !== "string") return null;

    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;

    const mime = match[1];
    const buffer = Buffer.from(match[2], "base64");

    if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) return null;

    const extension =
        mime === "image/png" ? "png" :
        mime === "image/webp" ? "webp" :
        "jpg";

    return { mime, buffer, extension };
}

async function uploadPhotoToNotion(token, photo, filename) {
    const created = await notionJsonRequest(token, "/file_uploads", {
        method: "POST",
        body: JSON.stringify({
            mode: "single_part",
            filename,
            content_type: photo.mime,
        }),
    });

    const form = new FormData();
    form.append(
        "file",
        new Blob([photo.buffer], { type: photo.mime }),
        filename
    );

    const response = await fetch(
        `https://api.notion.com/v1/file_uploads/${created.id}/send`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Notion-Version": NOTION_VERSION,
            },
            body: form,
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`Notion file upload ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
    }

    const uploaded = await response.json();

    if (uploaded.status !== "uploaded") {
        const error = new Error("Notion file upload did not finish");
        error.status = 502;
        throw error;
    }

    return uploaded.id;
}

async function markReturnPending(token, loanId, fileUploadId, filename) {
    return notionJsonRequest(token, `/pages/${loanId}`, {
        method: "PATCH",
        body: JSON.stringify({
            properties: {
                Status: { select: { name: "return_pending" } },
                "Return Requested At": { date: { start: new Date().toISOString() } },
                "Return Photo": {
                    files: [
                        {
                            type: "file_upload",
                            file_upload: { id: fileUploadId },
                            name: filename,
                        },
                    ],
                },
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

    const photo = parsePhoto(body?.photoData);
    if (!photo) {
        return res.status(400).json({
            code: "BAD_PHOTO",
            error: "Photo must be JPEG, PNG or WebP and no larger than 3 MB",
        });
    }

    let stage = "find_loan";

    try {
        const loan = await findCurrentLoan(notionToken, String(auth.user.id));

        if (!loan) {
            return res.status(409).json({ code: "NO_ACTIVE_LOAN", error: "No active loan" });
        }

        const status = loan.properties?.Status?.select?.name;

        if (status === "return_pending") {
            return res.status(409).json({ code: "ALREADY_PENDING", error: "Return is already pending" });
        }

        const filename = `return-${loan.id.replaceAll("-", "")}-${Date.now()}.${photo.extension}`;

        stage = "upload_photo";
        const fileUploadId = await uploadPhotoToNotion(
            notionToken,
            photo,
            filename
        );

        stage = "mark_pending";
        await markReturnPending(
            notionToken,
            loan.id,
            fileUploadId,
            filename
        );

        return res.status(200).json({
            ok: true,
            loanId: loan.id,
            status: "return_pending",
        });
    } catch (error) {
        console.error("Return request failed", error);
        return res.status(502).json({
            code: "NOTION_ERROR",
            error: "Не удалось отправить возврат",
            stage,
            notionStatus: error?.status || null,
        });
    }
};
