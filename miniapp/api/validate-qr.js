const crypto = require("crypto");

const MIR_QR_SHA256 = "420592ac67b13416c9c71c77e510eb0b9faa29c7ff1b01982bb74b51e99591f5";
const LEGACY_MIR_QR_SHA256 = "447db8c1666b435bc74f0c46f94beb4d35fc9cb607c2ef51d0faca92d3f535f2";
const BOT_USERNAME = "bookomirbot";

function sha256(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(a, b) {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");

    if (left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

function normalizeQrText(qrText) {
    const value = String(qrText || "").trim();

    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        const botPath = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();

        if (
            (host === "t.me" || host === "telegram.me") &&
            botPath === BOT_USERNAME
        ) {
            return url.searchParams.get("start") || "";
        }
    } catch {
        // Raw/legacy QR value. Validate it as-is.
    }

    return value;
}

function validateQr(qrText) {
    const normalized = normalizeQrText(qrText);
    if (!normalized) return false;

    const scannedHash = sha256(normalized);

    return (
        safeEqual(scannedHash, MIR_QR_SHA256) ||
        safeEqual(scannedHash, LEGACY_MIR_QR_SHA256)
    );
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    let body = req.body;

    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return res.status(400).json({ error: "Invalid JSON" });
        }
    }

    const qrText = typeof body?.qrText === "string" ? body.qrText : "";

    if (!qrText.trim()) {
        return res.status(400).json({ error: "QR text is required" });
    }

    return res.status(200).json({ valid: validateQr(qrText) });
};
