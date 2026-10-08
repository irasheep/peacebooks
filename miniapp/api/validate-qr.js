const crypto = require("crypto");

const QR_PREFIX = "knigi-mira:mir-shelf:v1:";

function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);

    if (left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

function normalizeEnvValue(value) {
    if (!value) return "";

    let normalized = String(value).trim();

    if (
        (normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
        normalized = normalized.slice(1, -1).trim();
    }

    if (normalized.startsWith("MIR_QR_TOKEN=")) {
        normalized = normalized.slice("MIR_QR_TOKEN=".length).trim();
    }

    if (normalized.startsWith("QR_PAYLOAD=")) {
        normalized = normalized.slice("QR_PAYLOAD=".length).trim();
    }

    return normalized;
}

function expectedQrText(configuredValue) {
    const normalized = normalizeEnvValue(configuredValue);

    if (normalized.startsWith(QR_PREFIX)) {
        return normalized;
    }

    return QR_PREFIX + normalized;
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const configuredValue = process.env.MIR_QR_TOKEN;

    if (!configuredValue) {
        return res.status(500).json({ error: "MIR QR token is not configured" });
    }

    let body = req.body;

    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return res.status(400).json({ error: "Invalid JSON" });
        }
    }

    const qrText = typeof body?.qrText === "string" ? body.qrText.trim() : "";

    if (!qrText) {
        return res.status(400).json({ error: "QR text is required" });
    }

    const expected = expectedQrText(configuredValue);
    const valid = safeEqual(qrText, expected);

    return res.status(200).json({ valid });
};
