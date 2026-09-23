const tg = window.Telegram?.WebApp;

const greetingElement = document.getElementById("greeting");
const usernameElement = document.getElementById("username");
const avatarElement = document.getElementById("avatar");
const statusElement = document.getElementById("telegram-status");
const catalogButton = document.getElementById("catalog-button");
const returnButton = document.getElementById("return-button");

function getInitial(name) {
    if (!name) return "К";
    return name.trim().charAt(0).toUpperCase();
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

        statusElement.textContent = "Открыто через Telegram";
    } else {
        statusElement.textContent = "Telegram не передал данные пользователя";
    }
} else {
    statusElement.textContent = "Режим браузера — данные Telegram недоступны";
}

catalogButton.addEventListener("click", () => {
    if (tg?.HapticFeedback) {
        tg.HapticFeedback.impactOccurred("light");
    }

    if (tg?.showAlert) {
        tg.showAlert("Каталог будет следующим экраном 📚");
    } else {
        alert("Каталог будет следующим экраном 📚");
    }
});

returnButton.addEventListener("click", () => {
    if (tg?.HapticFeedback) {
        tg.HapticFeedback.impactOccurred("light");
    }

    if (tg?.showAlert) {
        tg.showAlert("Возврат книги добавим следующим шагом 📚");
    } else {
        alert("Возврат книги добавим следующим шагом 📚");
    }
});
