"""Reed-Solomon sobre GF(256) con polinomio primitivo 0x11d."""

from __future__ import annotations

GF_POLY = 0x11D
GF_SIZE = 256

_EXP = [0] * 512
_LOG = [0] * GF_SIZE
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= GF_POLY
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def gf_mul(a: int, b: int) -> int:
    """Multiplica dos elementos de GF(256)."""
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def gf_inv(a: int) -> int:
    """Inverso multiplicativo en GF(256)."""
    if a == 0:
        raise ZeroDivisionError("inverso de cero en GF(256)")
    return _EXP[255 - _LOG[a]]


def _generator(nparity: int) -> list[int]:
    gen = [1]
    for i in range(nparity):
        root = _EXP[i]
        nxt = [0] * (len(gen) + 1)
        for j, coef in enumerate(gen):
            nxt[j] ^= coef
            nxt[j + 1] ^= gf_mul(coef, root)
        gen = nxt
    return gen


def encode(data: bytes, nparity: int) -> bytes:
    """Devuelve data seguido de nparity bytes de paridad."""
    if nparity < 0:
        raise ValueError("nparity negativo")
    if nparity == 0:
        return bytes(data)
    if len(data) + nparity > 255:
        raise ValueError("bloque RS demasiado largo")
    gen = _generator(nparity)
    work = list(data) + [0] * nparity
    for i in range(len(data)):
        coef = work[i]
        if coef:
            for j in range(len(gen)):
                work[i + j] ^= gf_mul(gen[j], coef)
    return bytes(data) + bytes(work[len(data):])


def _eval_desc(coeffs: bytes, x: int) -> int:
    y = 0
    for c in coeffs:
        y = gf_mul(y, x) ^ c
    return y


def _eval_asc(coeffs: list[int], x: int) -> int:
    y = 0
    for c in reversed(coeffs):
        y = gf_mul(y, x) ^ c
    return y


def _solve_gf(a: list[list[int]], b: list[int]) -> list[int]:
    n = len(a)
    m = [a[i][:] + [b[i]] for i in range(n)]
    for col in range(n):
        pivot = None
        for r in range(col, n):
            if m[r][col]:
                pivot = r
                break
        if pivot is None:
            raise ValueError("sistema singular")
        if pivot != col:
            m[col], m[pivot] = m[pivot], m[col]
        inv = gf_inv(m[col][col])
        m[col] = [gf_mul(v, inv) for v in m[col]]
        for r in range(n):
            if r != col and m[r][col]:
                f = m[r][col]
                m[r] = [m[r][c] ^ gf_mul(f, m[col][c]) for c in range(n + 1)]
    return [m[i][n] for i in range(n)]


def decode(block: bytes, nparity: int) -> bytes:
    """Corrige hasta nparity//2 errores; lanza ValueError si no es posible."""
    if nparity < 0:
        raise ValueError("nparity negativo")
    if nparity == 0:
        return bytes(block)
    if len(block) > 255:
        raise ValueError("bloque RS demasiado largo")
    if len(block) <= nparity:
        raise ValueError("bloque sin datos")

    syndromes = [_eval_desc(block, _EXP[j]) for j in range(nparity)]
    if not any(syndromes):
        return bytes(block[:-nparity])

    locator = [0] * (nparity + 1)
    prev = [0] * (nparity + 1)
    locator[0] = 1
    prev[0] = 1
    degree = 0
    shift = 1
    last = 1

    for n in range(nparity):
        disc = syndromes[n]
        for i in range(1, degree + 1):
            disc ^= gf_mul(locator[i], syndromes[n - i])
        if disc == 0:
            shift += 1
            continue
        coef = gf_mul(disc, gf_inv(last))
        old = locator[:]
        for i in range(nparity + 1 - shift):
            locator[i + shift] ^= gf_mul(coef, prev[i])
        if 2 * degree <= n:
            degree = n + 1 - degree
            prev = old
            last = disc
            shift = 1
        else:
            shift += 1

    if degree > nparity // 2:
        raise ValueError("demasiados errores")

    positions: list[tuple[int, int]] = []
    for idx in range(len(block)):
        power = len(block) - 1 - idx
        root = _EXP[(-power) % 255]
        if _eval_asc(locator, root) == 0:
            positions.append((idx, power))
    if len(positions) != degree:
        raise ValueError("locator inconsistente")

    xs = [_EXP[power % 255] for _, power in positions]
    rows = []
    for j in range(degree):
        rows.append([_pow_gf(x, j) for x in xs])
    magnitudes = _solve_gf(rows, syndromes[:degree])

    fixed = bytearray(block)
    for (idx, _), mag in zip(positions, magnitudes):
        fixed[idx] ^= mag

    if any(_eval_desc(fixed, _EXP[j]) for j in range(nparity)):
        raise ValueError("correccion fallida")
    return bytes(fixed[:-nparity])


def _pow_gf(x: int, e: int) -> int:
    if e == 0:
        return 1
    if x == 0:
        return 0
    return _EXP[(_LOG[x] * e) % 255]
