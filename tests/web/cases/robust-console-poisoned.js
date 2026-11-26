// A page that replaces Array.prototype.slice or join must still be able to log:
// console is the page's own diagnostic channel, and Chrome's does not route through
// the page's intrinsics. print() writes through console.log on Lava, so this is that
// path under poison.
const realSlice = Array.prototype.slice;
const realJoin = Array.prototype.join;
Array.prototype.slice = function () {
  throw new Error('slice poisoned');
};
Array.prototype.join = function () {
  throw new Error('join poisoned');
};
print('printed under poisoned slice and join');
Array.prototype.slice = realSlice;
Array.prototype.join = realJoin;
print('restored');
