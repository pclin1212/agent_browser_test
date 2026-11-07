// mini-admin 冻结数据集（确定性生成，值永远一致）
//
// 刻意复刻 WebArena / Magento admin 后台场景的数据形态：
//   - 60 条订单（#100000001-100000060），状态 pending/processing/complete/closed 循环；
//   - 每页 20 条，共 3 页；多条件筛选（状态 checkbox 组 + 客户名 + 日期范围）；
//   - 账号 admin / Password.123（localStorage ma_token 认证）。
// 生成规则固定，因此任何页码/筛选组合的结果都可静态推演（用例断言依赖这一点）。

var MA_USERS = {
  "admin": { password: "Password.123", name: "Admin User" }
};

var MA_CUSTOMERS = [
  "Emma Lopez", "James Carter", "Priya Nair", "Liam O'Brien", "Sofia Rossi",
  "Noah Kim", "Ava Johnson", "Lucas Martin", "Mia Davis", "Ethan Brown"
];

var MA_STATUSES = ["pending", "processing", "complete", "closed"];

(function () {
  var list = [];
  for (var i = 0; i < 60; i++) {
    var day = (i % 28) + 1;
    list.push({
      id: 100000001 + i,
      customer: MA_CUSTOMERS[i % 10],
      status: MA_STATUSES[i % 4],
      total: Math.round((45.99 + i * 13.37) * 100) / 100,
      date: "2022-10-" + (day < 10 ? "0" + day : "" + day),
      items: (i % 3) + 1,
      // 订单详情页用的冻结商品行
      lines: [
        { sku: "UGRN-" + (1000 + i), name: "UGREEN 3.5mm Audio Cable", qty: (i % 3) + 1, price: 12.5 },
        { sku: "SNYX-" + (2000 + i), name: "Sony MDR-ZX110 Headphones", qty: 1, price: 29.99 }
      ]
    });
  }
  var MA = window.MA_DATA = {};
  MA.orders = list;
})();
