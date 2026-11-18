// mini-admin 共享逻辑（Magento admin 后台复刻）
//
// 本站刻意复刻 WebArena / Magento admin 场景踩过的两个"陷阱"，作为负载验证的
// 关键交互模式（中后台管理系统普遍存在同类批量操作交互）：
//
//   [陷阱A1] 批量动作静默验证：订单列表的批量动作条是 原生 <select id="mass-action">
//           + 行 checkbox + #apply-btn。未选择动作（select 值为空）或未勾选任何行时
//           点击 Apply，事件处理器内直接 return——agent-browser rc==0（指令成功），
//           但无任何弹窗/提示/导航发生（指令成功 ≠ 功能成功）。
//   [陷阱A2] 删除确认弹窗懒插入：只有 select=delete 且勾选了行再点 Apply 时，
//           #confirm-modal 才被动态插进 DOM（此前 get/click 它都会因元素不存在而
//           失败）；弹窗出现后必须再 click #confirm-yes 才真正删除（Cancel 不删）。
//   其他拟真点：状态筛选是 checkbox 组 + 客户名 + 日期范围的多条件组合筛选，
//           筛选不自动生效，必须 click #filter-btn；分页是真实链接导航（?p=2）。

var MA = {
  esc: function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  },

  // ---- 认证（localStorage ma_token）----
  login: function (username, pass) {
    var u = MA_USERS[username];
    if (u && u.password === pass) {
      localStorage.setItem("ma_token", username);
      return u;
    }
    return null;
  },
  logout: function () { localStorage.removeItem("ma_token"); },
  user: function () {
    var t = localStorage.getItem("ma_token");
    return t && MA_USERS[t] ? MA_USERS[t] : null;
  },
  // 受保护页：未登录跳回登录页（Magento admin 的 /admin/）
  requireAuth: function () {
    if (!MA.user()) {
      window.location.replace("/admin/login/");
      return false;
    }
    return true;
  },

  // ---- 顶栏 ----
  renderHeader: function () {
    var h = document.getElementById("site-header");
    if (!h) return;
    var u = MA.user();
    var right = u
      ? "<span class='header-user'>" + MA.esc(u.name) + "</span><a href='#' id='header-signout'>Sign out</a>"
      : "<a href='/admin/login/'>Sign in</a>";
    h.innerHTML = "<a class='logo' href='/'>magento admin</a>" +
      "<nav class='site-nav'><a href='/'>Dashboard</a><a href='/admin/sales/order/'>Orders</a><a href='/admin/settings/'>Settings</a></nav>" +
      "<div class='header-right'>" + right + "</div>";
    var so = document.getElementById("header-signout");
    if (so) so.addEventListener("click", function () {
      MA.logout();
      window.location.href = "/admin/login/";
    });
  },

  // ---- 数据层（批量 hold/delete 的结果持久化在 localStorage）----
  loadOverrides: function () {
    try { return JSON.parse(localStorage.getItem("ma_overrides") || "{}"); }
    catch (e) { return {}; }
  },
  saveOverrides: function (o) { localStorage.setItem("ma_overrides", JSON.stringify(o)); },
  loadDeleted: function () {
    try { return JSON.parse(localStorage.getItem("ma_deleted") || "[]"); }
    catch (e) { return []; }
  },
  saveDeleted: function (d) { localStorage.setItem("ma_deleted", JSON.stringify(d)); },
  effectiveOrders: function () {
    var del = MA.loadDeleted(), ov = MA.loadOverrides();
    var delSet = {};
    del.forEach(function (d) { delSet[d] = 1; });
    return window.MA_DATA.orders
      .filter(function (o) { return !delSet[o.id]; })
      .map(function (o) { return ov[o.id] ? Object.assign({}, o, { status: ov[o.id] }) : o; });
  },
  findOrder: function (id) {
    var hit = MA.effectiveOrders().filter(function (o) { return o.id === id; });
    return hit[0] || null;
  },
  money: function (n) { return "$" + n.toFixed(2); },

  // ---- 仪表盘（统计卡 + 最近 5 单）----
  renderDashboard: function () {
    if (!document.getElementById("stats-cards")) return;
    var orders = MA.effectiveOrders();
    var counts = { pending: 0, processing: 0, complete: 0, closed: 0, hold: 0 };
    var revenue = 0;
    orders.forEach(function (o) {
      if (counts[o.status] !== undefined) counts[o.status]++;
      revenue += o.total;
    });
    document.getElementById("stat-total").textContent = String(orders.length);
    document.getElementById("stat-pending").textContent = String(counts.pending);
    document.getElementById("stat-processing").textContent = String(counts.processing);
    document.getElementById("stat-complete").textContent = String(counts.complete);
    document.getElementById("stat-closed").textContent = String(counts.closed);
    document.getElementById("stat-revenue").textContent = MA.money(revenue);
    var recent = orders.slice(-5).reverse();
    var t = document.getElementById("recent-orders");
    var html = "<tr><th>Order #</th><th>Status</th><th>Customer</th><th>Total</th><th>Date</th></tr>";
    recent.forEach(function (o) {
      html += "<tr class='order-row' data-id='" + o.id + "'>" +
        "<td><a class='order-link' href='/admin/sales/order/view/?id=" + o.id + "'>#" + o.id + "</a></td>" +
        "<td><span class='badge badge-" + o.status + "'>" + o.status + "</span></td>" +
        "<td class='cell-customer'>" + MA.esc(o.customer) + "</td>" +
        "<td class='cell-total'>" + MA.money(o.total) + "</td>" +
        "<td class='cell-date'>" + o.date + "</td></tr>";
    });
    t.innerHTML = html;
  },

  // ---- 订单列表：多条件筛选 + 20/页分页 ----
  filterState: function () {
    var p = new URLSearchParams(window.location.search);
    var st = (p.get("status") || "").split(",").filter(Boolean);
    return {
      p: Math.max(1, parseInt(p.get("p") || "1", 10) || 1),
      status: st,
      customer: p.get("customer") || "",
      from: p.get("from") || "",
      to: p.get("to") || ""
    };
  },
  filteredOrders: function (f) {
    return MA.effectiveOrders().filter(function (o) {
      if (f.status.length && f.status.indexOf(o.status) === -1) return false;
      if (f.customer && o.customer.toLowerCase().indexOf(f.customer.toLowerCase()) === -1) return false;
      if (f.from && o.date < f.from) return false;
      if (f.to && o.date > f.to) return false;
      return true;
    });
  },
  renderOrders: function () {
    var table = document.getElementById("orders-table");
    if (!table) return;
    var f = MA.filterState();
    // 同步筛选控件与 URL 状态
    ["pending", "processing", "complete", "closed"].forEach(function (s) {
      var cb = document.getElementById("f-" + s);
      if (cb) cb.checked = f.status.indexOf(s) !== -1;
    });
    var ci = document.getElementById("filter-customer");
    if (ci) ci.value = f.customer;
    var fi = document.getElementById("filter-from");
    if (fi) fi.value = f.from;
    var ti = document.getElementById("filter-to");
    if (ti) ti.value = f.to;

    var rows = MA.filteredOrders(f);
    var pages = Math.max(1, Math.ceil(rows.length / 20));
    if (f.p > pages) f.p = pages;
    var slice = rows.slice((f.p - 1) * 20, f.p * 20);
    var html = "<tr><th></th><th>Order #</th><th>Status</th><th>Customer</th><th>Total</th><th>Date</th></tr>";
    if (!slice.length) {
      html += "<tr><td colspan='6' class='empty'>We couldn't find any records.</td></tr>";
    }
    slice.forEach(function (o) {
      html += "<tr class='order-row' data-id='" + o.id + "'>" +
        "<td><input type='checkbox' class='order-checkbox' id='cb-" + o.id + "' data-id='" + o.id + "'></td>" +
        "<td><a class='order-link' href='/admin/sales/order/view/?id=" + o.id + "'>#" + o.id + "</a></td>" +
        "<td><span class='badge badge-" + o.status + "'>" + o.status + "</span></td>" +
        "<td class='cell-customer'>" + MA.esc(o.customer) + "</td>" +
        "<td class='cell-total'>" + MA.money(o.total) + "</td>" +
        "<td class='cell-date'>" + o.date + "</td></tr>";
    });
    table.innerHTML = html;

    // 分页链接（保留当前筛选参数的真实导航）
    var qs = function (page) {
      var q = new URLSearchParams();
      if (f.status.length) q.set("status", f.status.join(","));
      if (f.customer) q.set("customer", f.customer);
      if (f.from) q.set("from", f.from);
      if (f.to) q.set("to", f.to);
      q.set("p", page);
      return "/admin/sales/order/?" + q.toString();
    };
    var pg = document.getElementById("pagination");
    var html2 = "<span class='pg-label'>Page " + f.p + " of " + pages + "</span> ";
    for (var i = 1; i <= pages; i++) {
      html2 += "<a class='page-link" + (i === f.p ? " active" : "") + "' data-p='" + i +
        "' href='" + qs(i) + "'>" + i + "</a> ";
    }
    pg.innerHTML = html2;
    document.getElementById("orders-notice").textContent =
      document.getElementById("orders-notice").textContent || "";
    document.title = "Orders / Sales - magento admin";
  },
  initOrdersPage: function () {
    MA.renderOrders();
    var fb = document.getElementById("filter-btn");
    if (fb) fb.addEventListener("click", function () {
      var st = [];
      ["pending", "processing", "complete", "closed"].forEach(function (s) {
        var cb = document.getElementById("f-" + s);
        if (cb && cb.checked) st.push(s);
      });
      var q = new URLSearchParams();
      if (st.length) q.set("status", st.join(","));
      var cu = (document.getElementById("filter-customer").value || "").trim();
      if (cu) q.set("customer", cu);
      var fr = (document.getElementById("filter-from").value || "").trim();
      var to = (document.getElementById("filter-to").value || "").trim();
      if (fr) q.set("from", fr);
      if (to) q.set("to", to);
      history.replaceState(null, "", "/admin/sales/order/" + (q.toString() ? "?" + q.toString() : ""));
      MA.renderOrders();
    });
    MA.initMassActions();
  },

  // ---- 批量动作（[陷阱A1]/[陷阱A2] 见文件头注释）----
  initMassActions: function () {
    var apply = document.getElementById("apply-btn");
    if (!apply) return;
    apply.addEventListener("click", function () {
      var action = document.getElementById("mass-action").value;
      var checked = Array.prototype.slice.call(
        document.querySelectorAll(".order-checkbox:checked")
      ).map(function (c) { return parseInt(c.dataset.id, 10); });
      // [陷阱A1] 未选动作或未勾选任何行：静默 return（rc==0，页面零变化）
      if (!action || !checked.length) return;
      if (action === "hold") {
        var ov = MA.loadOverrides();
        checked.forEach(function (id) { ov[id] = "hold"; });
        MA.saveOverrides(ov);
        document.getElementById("orders-notice").textContent =
          checked.length + " order(s) put on hold.";
        MA.renderOrders();
      } else if (action === "delete") {
        // [陷阱A2] 确认弹窗此刻才懒插入 DOM
        MA.showConfirm(checked);
      }
    });
  },
  showConfirm: function (ids) {
    MA.hideConfirm();
    var m = document.createElement("div");
    m.id = "confirm-modal";
    m.className = "modal-overlay";
    m.innerHTML = "<div class='modal-box'>" +
      "<h3>Delete order(s)</h3>" +
      "<p>Are you sure you want to delete the selected order(s)? This action cannot be undone.</p>" +
      "<button id='confirm-yes' class='btn-danger'>Delete</button>" +
      "<button id='confirm-no' class='btn'>Cancel</button></div>";
    document.body.appendChild(m);
    document.getElementById("confirm-yes").addEventListener("click", function () {
      var del = MA.loadDeleted();
      ids.forEach(function (id) { if (del.indexOf(id) === -1) del.push(id); });
      MA.saveDeleted(del);
      MA.hideConfirm();
      document.getElementById("orders-notice").textContent =
        ids.length + " order(s) deleted.";
      MA.renderOrders();
    });
    document.getElementById("confirm-no").addEventListener("click", function () {
      MA.hideConfirm();
      document.getElementById("mass-action").value = "";
    });
  },
  hideConfirm: function () {
    var m = document.getElementById("confirm-modal");
    if (m) m.remove();
  },

  // ---- 订单详情（?id= 参数化）----
  renderOrderDetail: function () {
    var box = document.getElementById("order-detail");
    if (!box) return;
    var id = parseInt(new URLSearchParams(window.location.search).get("id") || "0", 10);
    var o = MA.findOrder(id);
    if (!o) {
      box.innerHTML = "<h1>Order not found</h1>" +
        "<p>No order with id #" + id + " exists.</p>" +
        "<a class='btn' href='/admin/sales/order/'>Back to orders</a>";
      return;
    }
    var html =
      "<h1 id='order-title'>Order #" + o.id + "</h1>" +
      "<div class='order-summary' id='order-info'>" +
        "<p><span class='lbl'>Status:</span> <span class='badge badge-" + o.status + "' id='order-status'>" + o.status + "</span></p>" +
        "<p><span class='lbl'>Customer:</span> <span id='order-customer'>" + MA.esc(o.customer) + "</span></p>" +
        "<p><span class='lbl'>Date:</span> <span id='order-date'>" + o.date + "</span></p>" +
      "</div>" +
      "<h2>Items Ordered</h2>" +
      "<table class='grid' id='order-lines'><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Price</th></tr>";
    o.lines.forEach(function (l) {
      html += "<tr><td>" + l.sku + "</td><td>" + MA.esc(l.name) + "</td><td>" +
        l.qty + "</td><td>" + MA.money(l.price) + "</td></tr>";
    });
    html += "</table>" +
      "<div class='grand-total' id='order-total'><span class='lbl'>Grand Total:</span> " +
      MA.money(o.total) + "</div>" +
      "<a class='btn' href='/admin/sales/order/'>Back to orders</a>";
    box.innerHTML = html;
    document.title = "Order #" + o.id + " / Sales - magento admin";
  },

  // ---- 登录页 ----
  initLogin: function () {
    var form = document.getElementById("login-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var u = (document.getElementById("username").value || "").trim();
      var p = document.getElementById("password").value || "";
      var rec = MA.login(u, p);
      if (!rec) {
        document.getElementById("login-err").textContent =
          "The account sign-in was incorrect or your account is disabled temporarily.";
        return;
      }
      window.location.href = "/";
    });
  }
};
