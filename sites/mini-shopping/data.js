// mini-shopping 冻结数据集
// 数据值刻意与 WebArena OneStopMarket 标定点一致（$306.68 / $6.99 / 订单 65.32、365.42、187 的
// Flat Rate - Fixed / 5 位评论者名单 / "Uneven color"），使 mini 用例与 wa-shopping 用例
// 逐条对应，两者的性能数字可直接对比校准。

var MS_USERS = {
  "emma.lopez@gmail.com": { password: "Password.123", name: "Emma Lopez" }
};

var MS_PRODUCTS = [
  // ---- q=earphone 结果（8 条，$306.68 在第一页）----
  { id: "p30668", name: "Over-Ear Wired Stereo Earphone with Deep Bass, $306.68", price: 306.68 },
  { id: "p-ear-1", name: "In-Ear Earphone Lightweight Wired Headset", price: 12.99 },
  { id: "p-ear-2", name: "Sport Earphone with Noise Isolating", price: 25.50 },
  { id: "p-ear-3", name: "Wireless Earphone Bluetooth 5.0", price: 39.99 },
  { id: "p-ear-4", name: "Kids Safe Volume Limited Earphone", price: 9.99 },
  { id: "p-ear-5", name: "Gaming Earphone with Detachable Mic", price: 45.00 },
  { id: "p-ear-6", name: "Earphone Carrying Case Hard Shell", price: 6.49 },
  { id: "p-ear-7", name: "USB-C Digital Earphone Adapter", price: 8.99 },

  // ---- q=ugreen 结果（含 $6.99）----
  { id: "p-ug-1", name: "UGREEN 3.5mm Audio Cable", price: 6.99 },
  { id: "p-ug-2", name: "UGREEN USB C to USB A Cable", price: 11.99 },
  { id: "p-ug-3", name: "UGREEN HDMI Cable 4K", price: 15.99 },
  { id: "p-ug-4", name: "UGREEN Ethernet Cable Cat7", price: 13.99 },

  // ---- q=sony bluetooth headphones 结果（前 3 款全名与 WebArena 一致）----
  { id: "p-sony-1", name: "SONY WH1000XM3 Bluetooth Wireless Noise Canceling Headphones Silver WH-1000XM3/S (Renewed)", price: 299.99 },
  { id: "p-sony-2", name: "Sony WH-CH710N/H Wireless Bluetooth Noise Cancelling Headphones", price: 128.00 },
  { id: "p-sony-3", name: "Sony WH-1000XM3B Wireless Bluetooth Noise-Canceling Over-Ear Headphones (Black) Basic Headphone Bundle Kit with Stylus", price: 348.00 },
  { id: "p-sony-4", name: "Sony Bluetooth In-Ear Headphones Extra Bass", price: 98.00 }
];

// 商品详情页数据（key = URL 文件名）
var MS_DETAILS = {
  "6s-wireless-headphones-over-ear-noise-canceling-hi-fi-bass-foldable-stereo-wireless-kid-headsets-earbuds-with-built-in-mic-micro-sd-tf-fm-for-iphone-samsung-ipad-pc-black-gold.html": {
    title: "6S Wireless Headphones Over-Ear Noise Canceling Hi-Fi Bass Foldable Stereo Wireless Kid Headsets Earbuds with Built-in Mic Micro SD/TF FM for iPhone Samsung iPad PC (Black & Gold)",
    price: 25.99,
    optionLabel: "Color",
    optionName: "options[51745]",
    reviews: [
      { name: "Joseph Brzezinski", text: "The earcups are too small, they hurt after 20 minutes." },
      { name: "Catso", text: "Sound is fine but the earcups felt small for adult ears." },
      { name: "Dibbins", text: "My ears got sweaty; earcups smaller than expected." },
      { name: "Anglebert Dinkherhump", text: "Great bass, however earcups too small for glasses wearers." },
      { name: "Michelle Davis", text: "Small earcups, decent battery life though." }
    ]
  },
  "mineralogie-all-natural-lip-gloss-ruby-rose.html": {
    title: "Mineralogie All Natural Lip Gloss - Ruby Rose",
    price: 14.50,
    reviews: [
      { name: "Karin Colon", text: "Uneven color, patchy application on the first coat." },
      { name: "Tracey Ray", text: "Nice gloss but the color is uneven compared to the picture." },
      { name: "Pam Fields", text: "Smells great, wish the shade were a ruby rose tone." }
    ]
  }
};

// 订单（登录态可见）
var MS_ORDERS = [
  { id: "189", date: "Oct 10, 2022", total: "65.32", status: "Complete" },
  { id: "188", date: "Sep 28, 2022", total: "365.42", status: "Cancelled" },
  { id: "187", date: "Sep 18, 2022", total: "148.00", status: "Complete" }
];

var MS_ORDER_187 = {
  id: "187",
  date: "Sep 18, 2022",
  shipping: "Flat Rate - Fixed",
  address: "Emma Lopez, 1180 Chestnut St, Los Angeles, CA 90026, United States"
};
