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

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const token = process.env.MIR_QR_TOKEN;

    if (!token) {
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

    const qrText = body?.qrText;

    if (typeof qrText !== "string" || !qrText) {
        return res.status(400).json({ error: "QR text is required" });
    }

    const expected = QR_PREFIX + token;
    const valid = safeEqual(qrText, expected);

    return res.status(200).json({ valid });
};
