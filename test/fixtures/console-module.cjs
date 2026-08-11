// Verifies that console output from required modules goes through the JSON protocol
// (load-time, call-time and async-callback output must all be JSON messages)
console.log("load time");
module.exports = function () {
  console.log("call time", 42);
  setTimeout(() => console.log("async time"), 20);
};
