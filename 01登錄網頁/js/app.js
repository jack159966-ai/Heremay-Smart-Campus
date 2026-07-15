function togglePassword() {
  const input = document.getElementById("password");
  input.type = input.type === "password" ? "text" : "password";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

function demoLogin() {
  showToast("登入示範：未來會進入今日首頁");
}

function faceLogin() {
  showToast("刷臉登入示範：未來會串接 Face ID");
}
