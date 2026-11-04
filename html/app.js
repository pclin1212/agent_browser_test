const toast = document.querySelector("#toast");

document.addEventListener("DOMContentLoaded", () => {
  bindLoginPage();
  bindInboxPage();
});

function bindLoginPage() {
  const form = document.querySelector("#login-form");
  const demoButton = document.querySelector("#demo-button");
  if (!form) return;

  demoButton.addEventListener("click", () => {
    document.querySelector("#username").value = "2021001234";
    document.querySelector("#password").value = "Jack@2024";
    showToast("已填入演示账号");
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    const username = document.querySelector("#username").value.trim();
    const password = document.querySelector("#password").value.trim();

    if (!username || !password) {
      showToast("请输入账号和密码");
      return;
    }

    localStorage.setItem("mailDemoLoggedIn", "true");
    localStorage.setItem("mailDemoUsername", username);
    document.querySelector("#login-status").classList.add("show");
    setTimeout(() => {
      window.location.href = "./home.html";
    }, 700);
  });
}

function bindInboxPage() {
  const filter = document.querySelector("#date-filter");
  const searchButton = document.querySelector("#search-button");
  const filterPanel = document.querySelector("#filter-panel");
  const filteredResult = document.querySelector("#filtered-result");
  if (!filter || !searchButton || !filterPanel || !filteredResult) return;

  searchButton.addEventListener("click", () => {
    if (filter.value !== "today") {
      showToast("请选择“今天”以匹配测试要求");
      return;
    }

    // 筛选后把唯一邮件结果放到 DOM 可见交互区最前，方便 snapshot -i 后 click @e1。
    filteredResult.classList.remove("hidden");
    filterPanel.classList.add("hidden");
    showToast("已筛选今天邮件：1 封");
  });
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(window.mailDemoToastTimer);
  window.mailDemoToastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}
