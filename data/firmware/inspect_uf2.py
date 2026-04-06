import struct
from pathlib import Path
p = Path('data/firmware/pico-micropython-uart0.uf2').read_bytes()
vals = []
for i in range(0, len(p), 512):
    b = p[i:i+512]
    if len(b) != 512:
        continue
    m0, m1 = struct.unpack('<II', b[:8])
    mend = struct.unpack('<I', b[508:512])[0]
    if m0 == 0x0A324655 and m1 == 0x9E5D5157 and mend == 0x0AB16F30:
        targ = struct.unpack('<I', b[12:16])[0]
        sz = struct.unpack('<I', b[16:20])[0]
        vals.append((targ, sz, b[32:32+sz]))
addrs = sorted(set(a for a, _, _ in vals))
print('blocks', len(vals), 'min', hex(addrs[0]), 'max', hex(addrs[-1]))
flash = bytearray([0xFF]) * (256 * 1024)
for a, sz, pay in vals:
    off = a - 0x10000000
    if 0 <= off < len(flash):
        n = min(sz, len(flash) - off)
        flash[off:off+n] = pay[:n]
for base in [0x0, 0x100, 0x200, 0x1000, 0x2000, 0x2100]:
    sp = int.from_bytes(flash[base:base+4], 'little')
    pc = int.from_bytes(flash[base+4:base+8], 'little')
    print(hex(base), 'SP', hex(sp), 'PC', hex(pc))
