// mini-gitlab 共享逻辑
//
// 本站刻意复刻 WebArena GitLab 场景踩过的三个"陷阱"，作为负载验证的关键
// 交互模式（这些坑在真实代码托管 / 工单类站点中普遍存在）：
//
//   [陷阱G1] 文件树懒渲染：tree.html 初始只渲染根级条目；src/ 的子条目在点击
//           .tree-item[data-path="src"] 目录行后才插入 DOM，src/utils/ 的子条目
//           又要等其目录行被点击才存在。跳步直接 click 深层行会因元素不存在而
//           指令失败；get text 深层文件名必须先逐层 click 展开。
//   [陷阱G2] 长内容提取：blob.html 把 139 行的冻结 JS 文本一次性 textContent
//           渲染进 <pre>，CLI 单条 get text 必须完整带回首行/末行/函数签名，
//           任何截断都会导致断言失败。
//   [陷阱G3] 自定义 div 下拉：issues/new 的 label 选择器是 div 实现，选项在
//           点击 #label-toggle 展开面板后才懒渲染进 DOM，必须 click 展开 +
//           click 选项两步；CLI 的 select 指令只作用于原生 <select>，对它无效，
//           不展开直接 click 隐藏选项也会因元素不存在而失败。
//   配套静默拦截：新 issue 标题为空时提交在事件处理器内直接 return，
//           CLI rc==0 但无任何导航发生（指令成功 ≠ 功能成功），仅行内报错。

var MG = {
  esc: function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  },

  // ---- 认证（localStorage mg_token）----
  login: function (username, pass) {
    var u = MG_USERS[username];
    if (u && u.password === pass) {
      localStorage.setItem("mg_token", username);
      return u;
    }
    return null;
  },
  logout: function () { localStorage.removeItem("mg_token"); },
  user: function () {
    var t = localStorage.getItem("mg_token");
    return t && MG_USERS[t] ? MG_USERS[t] : null;
  },
  // 受保护页：未登录跳回登录页（GitLab 的 /users/sign_in）
  requireAuth: function () {
    if (!MG.user()) {
      window.location.replace("/users/sign_in/");
      return false;
    }
    return true;
  },

  // ---- 顶栏（未登录显示 Sign in；已登录显示用户名 + Sign out）----
  renderHeader: function () {
    var h = document.getElementById("site-header");
    if (!h) return;
    var u = MG.user();
    var right = u
      ? "<span class='header-user'>" + MG.esc(u.name) + "</span><a href='#' id='header-signout'>Sign out</a>"
      : "<a href='/users/sign_in/'>Sign in</a>";
    h.innerHTML = "<a class='logo' href='/'>telemetry-dashboard</a>" +
      "<nav class='site-nav'><a href='/tree.html'>Code</a><a href='/issues/'>Issues</a><a href='/settings.html'>Settings</a></nav>" +
      "<div class='header-right'>" + right + "</div>";
    var so = document.getElementById("header-signout");
    if (so) so.addEventListener("click", function () {
      MG.logout();
      window.location.href = "/";
    });
  },

  // ---- 文件树 ----
  findNode: function (nodes, path) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].path === path) return nodes[i];
      if (nodes[i].children) {
        var hit = MG.findNode(nodes[i].children, path);
        if (hit) return hit;
      }
    }
    return null;
  },

  // 渲染一层条目；目录行点击才渲染下一层（[陷阱G1] 懒渲染）
  renderTreeLevel: function (container, nodes, depth) {
    nodes.forEach(function (node) {
      var row = document.createElement("div");
      row.className = "tree-item " + (node.type === "dir" ? "tree-dir" : "tree-file");
      row.dataset.path = node.path;
      row.dataset.type = node.type;
      row.dataset.depth = String(depth);
      row.style.paddingLeft = (depth * 20) + "px";
      if (node.type === "dir") {
        row.innerHTML = "<span class='tree-caret'>&#9656;</span> " + MG.esc(node.name) + "/";
      } else {
        row.innerHTML = "<a class='tree-file-link' href='/blob.html?file=" +
          encodeURIComponent(node.path) + "'>" + MG.esc(node.name) + "</a>";
      }
      container.appendChild(row);
    });
  },

  initTree: function () {
    var root = document.getElementById("tree-root");
    if (!root) return;
    MG.renderTreeLevel(root, MG_TREE, 0);
    root.addEventListener("click", function (e) {
      var row = e.target.closest(".tree-item.tree-dir");
      if (!row) return;
      var node = MG.findNode(MG_TREE, row.dataset.path);
      if (!node || !node.children) return;
      var child = root.querySelector(".tree-children[data-parent='" + row.dataset.path + "']");
      if (!child) {
        child = document.createElement("div");
        child.className = "tree-children";
        child.dataset.parent = row.dataset.path;
        row.insertAdjacentElement("afterend", child);
        MG.renderTreeLevel(child, node.children, parseInt(row.dataset.depth, 10) + 1);
        row.classList.add("expanded");
        row.querySelector(".tree-caret").innerHTML = "&#9662;";
      } else {
        var visible = child.style.display !== "none";
        child.style.display = visible ? "none" : "block";
        row.classList.toggle("expanded", !visible);
        row.querySelector(".tree-caret").innerHTML = visible ? "&#9656;" : "&#9662;";
      }
    });
  },

  // ---- [陷阱G2] 代码文件页（?file= 渲染冻结长文本）----
  renderBlob: function () {
    var file = new URLSearchParams(window.location.search).get("file") || "";
    var content = MG_FILES[file];
    var pathEl = document.getElementById("blob-path");
    var metaEl = document.getElementById("blob-meta");
    var pre = document.getElementById("blob-content");
    if (!content) {
      pathEl.textContent = file || "(none)";
      metaEl.textContent = "";
      document.getElementById("blob-title").textContent = "File not found";
      pre.textContent = "File not found in this repository.";
      document.title = "File not found - telemetry-dashboard";
      return;
    }
    pathEl.textContent = file;
    document.getElementById("blob-title").textContent = file.split("/").pop();
    metaEl.textContent = content.split("\n").length + " lines";
    pre.textContent = content;
    document.title = file + " - telemetry-dashboard";
  },

  // ---- issue 存储（新建条目存 localStorage，iid 从 #11 递增）----
  loadCreated: function () {
    try { return JSON.parse(localStorage.getItem("mg_new_issues") || "[]"); }
    catch (e) { return []; }
  },
  saveCreated: function (list) {
    localStorage.setItem("mg_new_issues", JSON.stringify(list));
  },
  allIssues: function () { return MG_ISSUES.concat(MG.loadCreated()); },
  findIssue: function (iid) {
    var hit = MG.allIssues().filter(function (i) { return i.iid === iid; });
    return hit[0] || null;
  },

  // ---- issue 列表（默认 state=opened；原生 select + 标签链接筛选）----
  renderIssueList: function () {
    var params = new URLSearchParams(window.location.search);
    var state = params.get("state") || "opened";
    if (["opened", "closed", "all"].indexOf(state) === -1) state = "opened";
    var label = params.get("label") || "";

    var sel = document.getElementById("state-filter");
    if (sel) sel.value = state;

    var bar = document.getElementById("label-filters");
    if (bar) {
      var html = "<span class='filters-label'>Label:</span> " +
        "<a class='label-filter" + (label ? "" : " active") + "' href='/issues/?state=" + state + "'>All</a> ";
      MG_LABELS.forEach(function (lb) {
        html += "<a class='label-filter label-" + lb + (label === lb ? " active" : "") +
          "' href='/issues/?state=" + state + "&label=" + lb + "'>" + lb + "</a> ";
      });
      bar.innerHTML = html;
    }

    var table = document.getElementById("issues-table");
    if (!table) return;
    var rows = MG.allIssues().filter(function (i) {
      if (state !== "all" && i.state !== state) return false;
      if (label && i.labels.indexOf(label) === -1) return false;
      return true;
    });
    if (!rows.length) {
      table.innerHTML = "<tr><td colspan='5' class='empty'>No issues match the current filters.</td></tr>";
      return;
    }
    var html = "<tr><th>#</th><th>Title</th><th>Labels</th><th>Status</th><th>Author</th></tr>";
    rows.forEach(function (i) {
      var labels = i.labels.map(function (lb) {
        return "<span class='label label-" + lb + "'>" + MG.esc(lb) + "</span>";
      }).join(" ");
      if (!labels) labels = "<span class='label label-none'>none</span>";
      var badge = i.state === "opened"
        ? "<span class='badge badge-open'>Opened</span>"
        : "<span class='badge badge-closed'>Closed</span>";
      html += "<tr class='issue-row' data-iid='" + i.iid + "' data-state='" + i.state + "'>" +
        "<td><a class='issue-link' href='/issues/view/?iid=" + i.iid + "'>#" + i.iid + "</a></td>" +
        "<td class='issue-title'><a href='/issues/view/?iid=" + i.iid + "'>" + MG.esc(i.title) + "</a></td>" +
        "<td>" + labels + "</td><td>" + badge + "</td><td>" + MG.esc(i.author) + "</td></tr>";
    });
    table.innerHTML = html;
  },

  initIssueList: function () {
    MG.renderIssueList();
    var sel = document.getElementById("state-filter");
    if (!sel) return;
    function onChange() {
      var label = new URLSearchParams(window.location.search).get("label") || "";
      var qs = "?state=" + sel.value + (label ? "&label=" + label : "");
      history.replaceState(null, "", "/issues/" + qs);
      MG.renderIssueList();
    }
    sel.addEventListener("change", onChange);
    sel.addEventListener("input", onChange);  // fill/type 只派发 input 系事件，双通道兜底
  },

  // ---- issue 详情（?iid=，冻结 + 新建合并渲染）----
  renderIssueDetail: function () {
    var iid = parseInt(new URLSearchParams(window.location.search).get("iid") || "0", 10);
    var issue = MG.findIssue(iid);
    var box = document.getElementById("issue-detail");
    if (!issue) {
      box.innerHTML = "<h1>Issue not found</h1><p>No issue with iid #" + iid +
        " exists in this project.</p><a class='issue-back' href='/issues/'>Back to issue list</a>";
      return;
    }
    var labels = issue.labels.map(function (lb) {
      return "<span class='label label-" + lb + "'>" + MG.esc(lb) + "</span>";
    }).join(" ");
    if (!labels) labels = "<span class='label label-none'>none</span>";
    var badge = issue.state === "opened"
      ? "<span class='badge badge-open'>Opened</span>"
      : "<span class='badge badge-closed'>Closed</span>";
    box.innerHTML =
      "<div class='issue-head'>" +
        "<h1 id='issue-title'>" + MG.esc(issue.title) + "</h1>" +
        "<div class='issue-meta'>" +
          "<span id='issue-iid'>Issue #" + issue.iid + "</span>" + badge +
          "<span class='issue-author'>opened by " + MG.esc(issue.author) + "</span>" +
          "<span class='issue-date'>" + MG.esc(issue.created) + "</span>" +
        "</div>" +
      "</div>" +
      "<div class='issue-labels'>" + labels + "</div>" +
      "<h2>Description</h2>" +
      "<div id='issue-description' class='issue-description'>" + MG.esc(issue.desc) + "</div>" +
      "<a class='issue-back' href='/issues/'>Back to issue list</a>";
    document.title = "#" + issue.iid + " " + issue.title + " - telemetry-dashboard";
  },

  // ---- 登录页（错账行内报错，正确则回首页）----
  initLogin: function () {
    var form = document.getElementById("login-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var u = MG.login(
        document.getElementById("username").value.trim(),
        document.getElementById("password").value
      );
      if (!u) {
        document.getElementById("login-err").textContent = "Invalid username or password.";
        return;
      }
      window.location.href = "/";
    });
  },

  // ---- 新建 issue 表单（需登录；[陷阱G3] 自定义 div 下拉 + 空标题静默拦截）----
  initIssueForm: function () {
    if (!MG.requireAuth()) return;
    var selectedLabel = "";
    var toggle = document.getElementById("label-toggle");
    var menu = document.getElementById("label-menu");

    // [陷阱G3] 选项展开时才懒渲染进 DOM
    toggle.addEventListener("click", function () {
      if (menu.hidden) {
        if (!menu.dataset.rendered) {
          var html = "";
          MG_LABELS.forEach(function (lb) {
            html += "<div class='dropdown-option' data-value='" + lb + "'>" + MG.esc(lb) + "</div>";
          });
          menu.innerHTML = html;
          menu.dataset.rendered = "1";
        }
        menu.hidden = false;
      } else {
        menu.hidden = true;
      }
    });
    menu.addEventListener("click", function (e) {
      var opt = e.target.closest(".dropdown-option");
      if (!opt) return;
      selectedLabel = opt.dataset.value;
      toggle.textContent = selectedLabel;
      menu.hidden = true;
    });

    document.getElementById("create-issue-btn").addEventListener("click", function () {
      var title = document.getElementById("issue-title").value.trim();
      var desc = document.getElementById("issue-description").value.trim();
      if (!title) {
        // 静默拦截：rc==0、无导航，仅行内报错
        document.getElementById("new-issue-err").textContent = "Title can't be blank.";
        return;
      }
      var created = MG.loadCreated();
      var iid = 11 + created.length;
      created.push({
        iid: iid,
        title: title,
        desc: desc || "(no description)",
        author: MG.user().name,
        labels: selectedLabel ? [selectedLabel] : [],
        state: "opened",
        created: "2022-11-06"
      });
      MG.saveCreated(created);
      window.location.href = "/issues/view/?iid=" + iid;
    });
  },

  // ---- 首页：README + 根级文件清单 ----
  initHome: function () {
    var readme = document.getElementById("readme-content");
    if (readme) readme.textContent = MG_FILES["README.md"];
    var list = document.getElementById("root-files");
    if (!list) return;
    var html = "";
    MG_TREE.forEach(function (node) {
      if (node.type === "dir") {
        html += "<li class='tree-item tree-dir'><a href='/tree.html'>" + MG.esc(node.name) + "/</a></li>";
      } else {
        html += "<li class='tree-item tree-file'><a class='tree-file-link' href='/blob.html?file=" +
          encodeURIComponent(node.path) + "'>" + MG.esc(node.name) + "</a></li>";
      }
    });
    list.innerHTML = html;
  }
};
