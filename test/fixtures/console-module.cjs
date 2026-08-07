// 用于验证 require 的模块的 console 输出走 JSON 协议
// （加载时、调用时、异步回调三个时机的输出都应是 JSON 消息）
console.log("load time");
module.exports = function () {
  console.log("call time", 42);
  setTimeout(() => console.log("async time"), 20);
};
