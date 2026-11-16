// node:string_decoder — decodes Buffers to strings while correctly handling a
// multi-byte character split across chunk boundaries. Ported from Node's algorithm:
// utf8/utf16le/base64 buffer their incomplete trailing bytes between write() calls;
// hex/latin1/ascii are 1:1 (or fixed-width) and need no carry.
(function (require, module, exports) {
  'use strict';

  function normalizeEncoding(enc) {
    var e = (enc || 'utf8').toLowerCase();
    switch (e) {
      case 'utf8':
      case 'utf-8':
        return 'utf8';
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return 'utf16le';
      case 'latin1':
      case 'binary':
        return 'latin1';
      case 'base64':
        return 'base64';
      case 'base64url':
        return 'base64url';
      case 'ascii':
        return 'ascii';
      case 'hex':
        return 'hex';
      default:
        throw new Error('Unknown encoding: ' + enc);
    }
  }

  function StringDecoder(encoding) {
    this.encoding = normalizeEncoding(encoding);
    this.lastNeed = 0; // bytes still required to finish the pending char
    this.lastTotal = 0; // total bytes of the pending char
    this.lastChar = Buffer.allocUnsafe(4); // holds the partial multi-byte char

    switch (this.encoding) {
      case 'utf16le':
        this.text = utf16Text;
        this.end = utf16End;
        break;
      case 'base64':
      case 'base64url':
        this.text = base64Text;
        this.end = base64End;
        break;
      default:
        if (this.encoding === 'utf8') {
          this.fillLast = utf8FillLast;
          this.text = utf8Text;
          this.end = utf8End;
        } else {
          // hex / latin1 / ascii — no multi-byte carry.
          this.text = simpleText;
          this.end = simpleEnd;
        }
    }
  }

  // Node's API accepts a Buffer, any TypedArray, or a DataView. Normalize a non-Buffer
  // ArrayBuffer view to a Buffer over the same bytes (no copy) so the Buffer methods
  // below (copy/toString) work and a Uint8Array isn't stringified as "97,98,...".
  function asBuffer(buf) {
    if (Buffer.isBuffer(buf)) return buf;
    if (ArrayBuffer.isView(buf)) {
      return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    return buf;
  }

  StringDecoder.prototype.write = function write(buf) {
    buf = asBuffer(buf);
    if (buf.length === 0) return '';
    var r;
    var i = 0;
    if (this.lastNeed) {
      r = this.fillLast(buf);
      if (r === undefined) return '';
      i = this.lastNeed;
      this.lastNeed = 0;
    }
    if (i < buf.length) {
      return r ? r + this.text(buf, i) : this.text(buf, i);
    }
    return r || '';
  };

  // --- UTF-8 ---

  // Returns how many bytes (1/2/3) at the end of `buf` start an incomplete sequence,
  // recording the partial bytes in lastChar. Returns 0 when the tail is complete.
  function utf8CheckIncomplete(self, buf, i) {
    var j = buf.length - 1;
    if (j < i) return 0;
    var nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) self.lastNeed = nb - 1;
      return nb;
    }
    if (--j < i || nb === -2) return 0;
    nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) self.lastNeed = nb - 2;
      return nb;
    }
    if (--j < i || nb === -2) return 0;
    nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) {
        if (nb === 2) nb = 0;
        else self.lastNeed = nb - 3;
      }
      return nb;
    }
    return 0;
  }

  // 0: ASCII, 2/3/4: leading byte of an N-byte sequence, -1: continuation, -2: invalid.
  function utf8CheckByte(byte) {
    if (byte <= 0x7f) return 0;
    if (byte >> 5 === 0x06) return 2;
    if (byte >> 4 === 0x0e) return 3;
    if (byte >> 3 === 0x1e) return 4;
    return byte >> 6 === 0x02 ? -1 : -2;
  }

  function utf8FillLast(buf) {
    var p = this.lastTotal - this.lastNeed;
    var r = utf8CheckExtraBytes(this, buf);
    if (r !== undefined) return r;
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, p, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, p, 0, buf.length);
    this.lastNeed -= buf.length;
  }

  // Validate that the buffered continuation bytes are well-formed; on a bad byte, Node
  // emits a single replacement char per the spec's substitution-of-maximal-subparts.
  function utf8CheckExtraBytes(self, buf) {
    if ((buf[0] & 0xc0) !== 0x80) {
      self.lastNeed = 0;
      return '�';
    }
    if (self.lastNeed > 1 && buf.length > 1) {
      if ((buf[1] & 0xc0) !== 0x80) {
        self.lastNeed = 1;
        return '�';
      }
      if (self.lastNeed > 2 && buf.length > 2) {
        if ((buf[2] & 0xc0) !== 0x80) {
          self.lastNeed = 2;
          return '�';
        }
      }
    }
  }

  function utf8Text(buf, i) {
    var total = utf8CheckIncomplete(this, buf, i);
    if (!this.lastNeed) return buf.toString('utf8', i);
    this.lastTotal = total;
    var end = buf.length - (total - this.lastNeed);
    buf.copy(this.lastChar, 0, end);
    return buf.toString('utf8', i, end);
  }

  function utf8End(buf) {
    var r = buf && buf.length ? this.write(buf) : '';
    if (this.lastNeed) return r + '�';
    return r;
  }

  // --- UTF-16LE ---

  function utf16Text(buf, i) {
    if ((buf.length - i) % 2 === 0) {
      var r = buf.toString('utf16le', i);
      if (r) {
        var c = r.charCodeAt(r.length - 1);
        if (c >= 0xd800 && c <= 0xdbff) {
          // Ends on a high surrogate — hold its 2 bytes for the next chunk.
          this.lastNeed = 2;
          this.lastTotal = 4;
          this.lastChar[0] = buf[buf.length - 2];
          this.lastChar[1] = buf[buf.length - 1];
          return r.slice(0, -1);
        }
      }
      return r;
    }
    // Odd byte left over: hold it.
    this.lastNeed = 1;
    this.lastTotal = 2;
    this.lastChar[0] = buf[buf.length - 1];
    return buf.toString('utf16le', i, buf.length - 1);
  }

  function utf16End(buf) {
    var r = buf && buf.length ? this.write(buf) : '';
    if (this.lastNeed) {
      var end = this.lastTotal - this.lastNeed;
      return r + this.lastChar.toString('utf16le', 0, end);
    }
    return r;
  }

  // --- base64 (groups of 3 bytes -> 4 chars) ---

  function base64Text(buf, i) {
    var n = (buf.length - i) % 3;
    if (n === 0) return buf.toString(this.encoding, i);
    this.lastNeed = 3 - n;
    this.lastTotal = 3;
    if (n === 1) {
      this.lastChar[0] = buf[buf.length - 1];
    } else {
      this.lastChar[0] = buf[buf.length - 2];
      this.lastChar[1] = buf[buf.length - 1];
    }
    return buf.toString(this.encoding, i, buf.length - n);
  }

  function base64End(buf) {
    var r = buf && buf.length ? this.write(buf) : '';
    if (this.lastNeed) {
      return r + this.lastChar.toString(this.encoding, 0, 3 - this.lastNeed);
    }
    return r;
  }

  // shared fillLast for utf16le/base64: accumulate the held bytes, then decode.
  function simpleFillLast(buf) {
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
    this.lastNeed -= buf.length;
  }

  // --- hex / latin1 / ascii (no carry) ---

  function simpleText(buf, i) {
    return buf.toString(this.encoding, i);
  }

  function simpleEnd(buf) {
    return buf && buf.length ? this.write(buf) : '';
  }

  // utf16le and base64 share simpleFillLast (set after the constructor's switch).
  StringDecoder.prototype.fillLast = simpleFillLast;

  module.exports = { StringDecoder: StringDecoder };
});
