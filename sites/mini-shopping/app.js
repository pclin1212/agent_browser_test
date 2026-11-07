// mini-shopping 共享逻辑
//
// 本站刻意复刻 WebArena OneStopMarket(Magento) 踩过的三个"陷阱"，作为负载验证的
// 关键交互模式（这些坑在真实业务站中普遍存在）：
//
//   [陷阱1] 搜索框只认真实键盘事件（keydown）：Enter 提交时使用 keydown 累积的缓冲区，
//           而非 input.value —— fill/type（只派发 input 事件）提交空查询被静默拦截，
//           只有真实按键（press / 物理键盘）才能输入生效。复刻 keydown-only 类组件
//           （自动补全、快捷键组件等），这正是 WebArena 第一轮搜索用例翻车的机制。
//   [陷阱2] 商品评论懒渲染：Reviews 面板内容在点击 #tab-label-reviews 前不存在于 DOM，
//           get text 提前读取拿不到评论者名单。
//   [陷阱3] 必选商品选项的静默验证：未勾选 options[51745] 时点击加购按钮被前端拦截，
//           rc==0 但无任何导航发生（指令成功 ≠ 功能成功）。

var MS = {
  esc: function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  },

  // ---- 认证 ----
  login: function (email, pass) {
    var u = MS_USERS[email];
    if (u && u.password === pass) {
      localStorage.setItem("ms_token", email);
      return u;
    }
    return null;
  },
  logout: function () { localStorage.removeItem("ms_token"); },
  user: function () {
    var t = localStorage.getItem("ms_token");
    return t && MS_USERS[t] ? MS_USERS[t] : null;
  },
  // 受保护页：未登录跳回登录页（相对路径前缀 = 目录深度）
  requireAuth: function () {
    if (!MS.user()) {
      var segs = window.location.pathname.split("/").filter(Boolean);
      var prefix = new Array(segs.length).join("../");  // segs 含文件名，故重复 segs-1 次
      window.location.replace(prefix + "customer/account/login/");
    }
  },

  // ---- [陷阱1] 搜索框：只认 keydown 累积的字符 ----
  initSearchTrap: function (inputSel) {
    var buf = "";
    var inp = document.querySelector(inputSel || "#search");
    if (!inp) return;
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (buf.trim()) {
          window.location.href = "search.html?q=" + encodeURIComponent(buf);
        }
        // 缓冲为空则静默不动 —— 复刻 Magento fill+Enter 停在首页的现象
        return;
      }
      if (e.key === "Backspace") buf = buf.slice(0, -1);
      else if (e.key && e.key.length === 1) buf += e.key;
    });
  },

  // ---- 搜索结果渲染（前端分页）----
  renderSearch: function (el, pageSize) {
    var q = new URLSearchParams(window.location.search).get("q") || "";
    var p = parseInt(new URLSearchParams(window.location.search).get("p") || "1", 10);
    pageSize = pageSize || 6;
    var hits = MS_PRODUCTS.filter(function (x) {
      return x.name.toLowerCase().indexOf(q.toLowerCase()) !== -1;
    });
    var totalPages = Math.max(1, Math.ceil(hits.length / pageSize));
    if (p < 1 || p > totalPages) p = 1;
    var html = "<h1>Search results for: '" + MS.esc(q) + "'</h1>" +
      "<p class='result-count'>" + hits.length + " items found</p><ul class='product-grid'>";
    hits.slice((p - 1) * pageSize, p * pageSize).forEach(function (x) {
      html += "<li class='product-item'><a class='product-item-link' href='#'>" +
        MS.esc(x.name) + "</a><span class='price'>$" + x.price.toFixed(2) + "</span></li>";
    });
    html += "</ul>";
    if (totalPages > 1) {
      html += "<div class='pages'>";
      for (var i = 1; i <= totalPages; i++)
        html += "<a href='search.html?q=" + encodeURIComponent(q) + "&p=" + i + "'>Page " + i + "</a> ";
      html += "</div>";
    }
    el.innerHTML = html;
    document.title = "Search results for: '" + q + "' - mini-shopping";
  },

  // ---- 商品详情页 ----
  initProduct: function (pageKey) {
    var d = MS_DETAILS[pageKey];
    if (!d) return;
    document.getElementById("product-name").textContent = d.title;
    document.getElementById("product-price").textContent = "$" + d.price.toFixed(2);

    // [陷阱2] Reviews 懒渲染：点击前 DOM 中无任何评论内容
    var reviewsBtn = document.getElementById("tab-label-reviews");
    var panel = document.getElementById("reviews");
    reviewsBtn.addEventListener("click", function () {
      document.getElementById("tab-label-details").classList.remove("active");
      reviewsBtn.classList.add("active");
      if (!panel.dataset.rendered) {
        var html = "";
        d.reviews.forEach(function (r) {
          html += "<li class='review'><strong>" + MS.esc(r.name) + "</strong>" +
            "<p>" + MS.esc(r.text) + "</p></li>";
        });
        panel.innerHTML = "<ol class='review-list'>" + html + "</ol>";
        panel.dataset.rendered = "1";
      }
      panel.style.display = "block";
      document.getElementById("details").style.display = "none";
    });
    document.getElementById("tab-label-details").addEventListener("click", function () {
      this.classList.add("active");
      reviewsBtn.classList.remove("active");
      document.getElementById("details").style.display = "block";
      panel.style.display = "none";
    });

    // [陷阱3] 必选选项静默验证：未选 radio 时点加购被拦截、无导航
    // （无 optionName 的商品不做拦截）
    var btn = document.getElementById("product-addtocart-button");
    btn.addEventListener("click", function () {
      var chosen = d.optionName
        ? document.querySelector("input[name='" + d.optionName + "']:checked")
        : { value: "" };
      if (!chosen) {
        var msg = document.getElementById("option-msg");
        msg.textContent = "You need to choose options for your item.";
        return; // 静默失败：rc==0、无跳转
      }
      var cart = JSON.parse(localStorage.getItem("ms_cart") || "[]");
      cart.push({ name: d.title, price: d.price, option: chosen.value });
      localStorage.setItem("ms_cart", JSON.stringify(cart));
      window.location.href = "checkout/cart/";  // 商品页在站点根，相对路径直达
    });
  },

  // ---- 购物车 ----
  renderCart: function (el) {
    var cart = JSON.parse(localStorage.getItem("ms_cart") || "[]");
    if (!cart.length) {
      el.innerHTML = "<h1>Shopping Cart</h1><p>You have no items in your shopping cart.</p>";
      return;
    }
    var html = "<h1>Shopping Cart</h1><table class='cart'><tr><th>Item</th><th>Price</th></tr>";
    cart.forEach(function (c) {
      html += "<tr><td>" + MS.esc(c.name) + "</td><td>$" + c.price.toFixed(2) + "</td></tr>";
    });
    html += "</table>";
    el.innerHTML = html;
  }
};
