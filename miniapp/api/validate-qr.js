const crypto = require("crypto");

const MIR_QR_SHA256 = "447db8c1666b435bc74f0c46f94beb4d35fc9cb607c2ef51d0faca92d3f535f2";

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

    const qrText = typeof body?.qrText === "string" ? body.qrText.trim() : "";

    if (!qrText) {
        return res.status(400).json({ error: "QR text is required" });
    }

    const scannedHash = sha256(qrText);
    const valid = safeEqual(scannedHash, MIR_QR_SHA256);

    return res.status(200).json({ valid });
};
