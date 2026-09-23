const DATA_SOURCE_ID = "3e496b5b-b336-80dd-84bb-000bd8ec8192";
const NOTION_VERSION = "2026-03-11";

function plainText(property) {
    if (!property) return "";

    const parts = property.title || property.rich_text || [];
    return parts.map((item) => item.plain_text || item.text?.content || "").join("").trim();
}

function fileUrl(property) {
    const file = property?.files?.[0];
    if (!file) return "";

    return file.external?.url || file.file?.url || file.file_upload?.url || "";
}

function normalizeBook(page) {
    const properties = page.properties || {};

    return {
        id: page.id,
        title: plainText(properties["Book Name"]),
        author: plainText(properties["Author"]),
        annotation: plainText(properties["Annotation"]),
        isbn: plainText(properties["ISBN"]),
        cover: fileUrl(properties["Files & media"]),
        status: properties["Status"]?.status?.name || "Не указан",
        createdAt: properties["Created time"]?.created_time || page.created_time || null,
    };
}

async function fetchAllBooks(token) {
    const results = [];
    let cursor = null;

    do {
        const response = await fetch(
            `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Notion-Version": NOTION_VERSION,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    page_size: 100,
                    ...(cursor ? { start_cursor: cursor } : {}),
                    sorts: [
                        {
                            property: "Created time",
                            direction: "descending",
                        },
                    ],
                }),
            }
        );

        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Notion API ${response.status}: ${detail}`);
        }

        const data = await response.json();
        results.push(...data.results);
        cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    return results.map(normalizeBook);
}

function isCompleteBook(book) {
    return Boolean(
        book.title &&
        book.author &&
        book.annotation &&
        book.isbn &&
        book.cover &&
        book.status &&
        book.status !== "Не указан" &&
        book.createdAt
    );
}

function sortCatalog(books) {
    return books.sort((a, b) => {
        const aAvailable = a.status === "На полке" ? 0 : 1;
        const bAvailable = b.status === "На полке" ? 0 : 1;

        if (aAvailable !== bAvailable) {
            return aAvailable - bAvailable;
        }

        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
    }

    const token = process.env.Notion_Token;

    if (!token) {
        return res.status(500).json({ error: "Notion token is not configured" });
    }

    try {
        const allBooks = await fetchAllBooks(token);
        const books = sortCatalog(allBooks.filter(isCompleteBook));
        const skippedIncomplete = allBooks.length - books.length;

        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        return res.status(200).json({ books, skippedIncomplete });
    } catch (error) {
        console.error("Failed to load catalog from Notion", error);
        return res.status(502).json({ error: "Не удалось загрузить каталог" });
    }
};
