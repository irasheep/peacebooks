const tg = window.Telegram?.WebApp;

const screens = {
    home: document.getElementById("home-screen"),
    catalog: document.getElementById("catalog-screen"),
    book: document.getElementById("book-screen"),
};

const greetingElement = document.getElementById("greeting");
const usernameElement = document.getElementById("username");
const avatarElement = document.getElementById("avatar");

const catalogButton = document.getElementById("catalog-button");
const returnButton = document.getElementById("return-button");
const borrowButton = document.getElementById("borrow-button");

const catalogGrid = document.getElementById("catalog-grid");
const catalogMessage = document.getElementById("catalog-message");

const bookCover = document.getElementById("book-cover");
const bookStatus = document.getElementById("book-status");
const bookTitle = document.getElementById("book-title");
const bookAuthor = document.getElementById("book-author");
const bookAnnotation = document.getElementById("book-annotation");
const unavailableNote = document.getElementById("unavailable-note");

let books = [];
let catalogLoaded = false;
let currentScreen = "home";
let selectedBookId = null;

function getInitial(name) {
    if (!name) return "К";
    return name.trim().charAt(0).toUpperCase();
}

function tapFeedback() {
    tg?.HapticFeedback?.impactOccurred("light");
}

function escapeHtml(value = "") {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setScreen(name) {
    Object.entries(screens).forEach(([screenName, element]) => {
        element.classList.toggle("is-active", screenName === name);
    });

    currentScreen = name;
    window.scrollTo({ top: 0, behavior: "auto" });

    if (tg?.BackButton) {
        if (name === "home") {
            tg.BackButton.hide();
        } else {
            tg.BackButton.show();
        }
    }
}

function handleTelegramBack() {
    if (currentScreen === "book") {
        showCatalog();
        return;
    }

    if (currentScreen === "catalog") {
        setScreen("home");
    }
}

function bookStatusClass(status) {
    return status === "На полке" ? "is-available" : "is-unavailable";
}

function renderCatalog() {
    catalogGrid.innerHTML = books
        .map((book) => {
            const title = escapeHtml(book.title || "Без названия");
            const author = escapeHtml(book.author || "Автор не указан");
            const status = escapeHtml(book.status || "Статус не указан");
            const cover = escapeHtml(book.cover || "");
            const coverMarkup = cover
                ? `<img class="catalog-cover" src="${cover}" alt="Обложка книги «${title}»" loading="lazy">`
                : `<div class="catalog-cover cover-placeholder">Нет обложки</div>`;

            return `
                <button class="book-card" type="button" data-book-id="${escapeHtml(book.id)}">
                    <div class="catalog-cover-wrap">
                        ${coverMarkup}
                    </div>
                    <div class="book-card-copy">
                        <h3>${title}</h3>
                        <p>${author}</p>
                        <span class="status-badge ${bookStatusClass(book.status)}">${status}</span>
                    </div>
                </button>
            `;
        })
        .join("");

    catalogMessage.hidden = books.length > 0;

    if (!books.length) {
        catalogMessage.textContent = "Пока в каталоге нет книг.";
    }

    catalogGrid.querySelectorAll(".book-card").forEach((card) => {
        card.addEventListener("click", () => {
            tapFeedback();
            showBook(card.dataset.bookId);
        });
    });
}

async function loadCatalog() {
    if (catalogLoaded) return;

    catalogMessage.hidden = false;
    catalogMessage.textContent = "Загружаю книги…";

    try {
        const response = await fetch("/api/books");

        if (!response.ok) {
            throw new Error(`Catalog request failed: ${response.status}`);
        }

        const data = await response.json();
        books = Array.isArray(data.books) ? data.books : [];
        catalogLoaded = true;
        renderCatalog();
    } catch (error) {
        console.error(error);
        catalogMessage.hidden = false;
        catalogMessage.textContent = "Не удалось загрузить каталог. Попробуй обновить приложение.";
    }
}

async function showCatalog() {
    setScreen("catalog");
    await loadCatalog();
}

function showBook(bookId) {
    const book = books.find((item) => item.id === bookId);
    if (!book) return;

    selectedBookId = book.id;

    bookTitle.textContent = book.title || "Без названия";
    bookAuthor.textContent = book.author || "Автор не указан";
    bookAnnotation.textContent = book.annotation || "Аннотация пока не добавлена.";
    bookStatus.textContent = book.status || "Статус не указан";
    bookStatus.className = `status-badge ${bookStatusClass(book.status)}`;

    if (book.cover) {
        bookCover.src = book.cover;
        bookCover.alt = `Обложка книги «${book.title || ""}»`;
        bookCover.parentElement.classList.remove("is-placeholder");
    } else {
        bookCover.removeAttribute("src");
        bookCover.alt = "";
        bookCover.parentElement.classList.add("is-placeholder");
    }

    const available = book.status === "На полке";
    borrowButton.hidden = !available;
    unavailableNote.hidden = available;

    setScreen("book");
}

if (tg) {
    tg.ready();
    tg.expand();

    const user = tg.initDataUnsafe?.user;

    if (user) {
        const firstName = user.first_name || "читатель";

        greetingElement.textContent = `Привет, ${firstName}!`;
        avatarElement.textContent = getInitial(firstName);

        if (user.username) {
            usernameElement.textContent = `@${user.username}`;
        } else {
            usernameElement.textContent = "Рада видеть тебя в библиотеке.";
        }
    }

    tg.BackButton?.onClick(handleTelegramBack);
}

catalogButton.addEventListener("click", () => {
    tapFeedback();
    showCatalog();
});

borrowButton.addEventListener("click", () => {
    tapFeedback();

    const book = books.find((item) => item.id === selectedBookId);
    const message = book
        ? `«${book.title}» можно взять. Саму выдачу подключим следующим этапом.`
        : "Саму выдачу подключим следующим этапом.";

    if (tg?.showAlert) {
        tg.showAlert(message);
    } else {
        alert(message);
    }
});

returnButton.addEventListener("click", () => {
    tapFeedback();

    const message = "Возврат с фотографией подключим следующим этапом.";

    if (tg?.showAlert) {
        tg.showAlert(message);
    } else {
        alert(message);
    }
});
