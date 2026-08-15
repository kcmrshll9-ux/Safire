const net = require('node:net');

net.Server.prototype.listen = function denyNetworkListen() {
  throw new Error('Network listeners are forbidden in this test');
};
