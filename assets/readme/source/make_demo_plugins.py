"""Keyframes -> README demo GIF for Video Summary (vs) and Polyglot Helper (pg).

    python3 make_demo_plugins.py <vs|pg> <frames dir> <light|dark> <out.gif>

Uses Film from make_demo.py (cursor, click ripple, highlight ring, camera, rounded card frame).
"""
import json
import sys
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_demo import Film, ACCENT, smooth  # noqa: E402

SCALE = 2


def load(d):
    d = Path(d)
    boxes = {k: [v * SCALE for v in b] for k, b in json.loads((d / "boxes.json").read_text()).items()}
    shots = {}
    for f in sorted(d.glob("*.png")):
        shots.setdefault(f.stem.split("-", 1)[1], []).append(Image.open(f).convert("RGB"))
    return boxes, shots


def centre(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def glide(film, img, cam, a, b, n=10, ms=35):
    for k in range(1, n + 1):
        film.add(img, cam, ms, cursor=film.mix(a, b, smooth(k / n)))


def click(film, img, cam, at):
    for k in range(4):
        film.add(img, cam, 45, cursor=at, ripple=(*at, k / 3))


def travel(film, img, a, b, n=10, ms=50, **kw):
    for k in range(1, n + 1):
        film.add(img, film.mix(a, b, smooth(k / n)), ms, **kw)


def fade(film, a, b, cam, n=6, ms=60):
    for k in range(1, n + 1):
        film.add(Image.blend(a, b, k / n), cam, ms)


def vs(d, mode, out):
    boxes, s = load(d)
    start = s["start"][0]
    film = Film(mode, start.size)
    side = film.cam(1624, 84, start.width - 1624)
    row_cam = film.around(boxes["row"], start.width - 1624)
    main = film.cam(film.full[0], 84, 1620 - film.full[0])
    inp = (boxes["input"][0] + 120 * SCALE, centre(boxes["input"])[1])
    go = centre(boxes["start"])
    enter = (start.width - 160, start.height - 200)

    film.add(start, side, 700)
    glide(film, start, side, enter, inp)
    click(film, start, side, inp)
    for img in s["type"]:
        film.add(img, side, 110, cursor=inp)
    film.add(s["type"][-1], side, 300, cursor=inp)
    glide(film, s["type"][-1], side, inp, go, n=8)
    click(film, s["type"][-1], side, go)
    work = s["working"][0]
    travel(film, work, side, row_cam, n=8, cursor=go)
    film.add(work, row_cam, 1100)
    done = s["done"][0]
    fade(film, work, done, row_cam)  # the wait is cut
    film.add(done, row_cam, 400, ring=boxes["row"], ring_color=ACCENT[mode])
    film.add(done, row_cam, 600, ring=boxes["row"], ring_color=ACCENT[mode])
    row = centre(boxes["row"])
    glide(film, done, row_cam, go, row, n=8)
    click(film, done, row_cam, row)
    detail = s["detail"][0]
    travel(film, detail, row_cam, side, n=6, cursor=row)
    opn = centre(boxes["open"])
    glide(film, detail, side, row, opn, n=8)
    film.add(detail, side, 250, cursor=opn, ring=boxes["open"], ring_color=ACCENT[mode])
    click(film, detail, side, opn)
    note = s["note"][0]
    travel(film, note, side, main, n=12, ms=55)
    film.add(note, main, 1000)
    film.add(note, main, 1500, ring=boxes["summary"], ring_color=ACCENT[mode])
    film.add(s["scrolled"][0], main, 2800)
    film.save(out)


def pg(d, mode, out):
    boxes, s = load(d)
    start = s["start"][0]
    film = Film(mode, start.size)
    wide = film.around((312 * SCALE, 72 * SCALE, 1012 * SCALE, 584 * SCALE), 820 * SCALE)
    near = film.around(boxes["card"], 560 * SCALE)
    word = centre(boxes["word"])
    item = centre(boxes["item"])
    add = centre(boxes["add"])
    mark = centre(boxes["mark"])
    enter = (wide[2] - 60, wide[3] - 60)

    film.add(start, wide, 700)
    glide(film, start, wide, enter, word)
    film.add(s["select"][0], wide, 500, cursor=word)
    click(film, s["select"][0], wide, word)
    menu = s["menu"][0]
    menu_cam = film.around(boxes["menu"], 820 * SCALE)
    travel(film, menu, wide, menu_cam, n=8, cursor=word)
    glide(film, menu, menu_cam, word, item, n=10)
    film.add(menu, menu_cam, 250, cursor=item, ring=boxes["item"], ring_color=ACCENT[mode])
    click(film, menu, menu_cam, item)
    card = s["card"][0]
    travel(film, card, menu_cam, near, n=10, cursor=item)
    film.add(card, near, 900, cursor=item, ring=boxes["card"], ring_color=ACCENT[mode])
    glide(film, card, near, item, add, n=8)
    click(film, card, near, add)
    film.add(s["added"][0], near, 1000, cursor=add)
    reading = s["reading"][0]
    fade(film, s["added"][0], reading, near, n=6)
    travel(film, reading, near, wide, n=10)
    film.add(reading, wide, 600)
    glide(film, reading, wide, add, mark, n=8)
    film.add(s["hover"][0], wide, 2600, cursor=mark)
    film.save(out)


if __name__ == "__main__":
    {"vs": vs, "pg": pg}[sys.argv[1]](*sys.argv[2:5])
