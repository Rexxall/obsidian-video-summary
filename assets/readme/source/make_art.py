"""Render the README hero and the three cards, light and dark, English and Chinese.

    python3 make_art.py        writes ../hero-*.svg and ../cards-*.svg
"""
from pathlib import Path

THEMES = {
    "light": dict(bg="#F7F6FB", fg="#1D1B26", muted="#6B6780", line="#E4E1EE", card="#FFFFFF",
                  accent="#7A5AF0", accent_soft="#EEE9FF", green="#22855A", green_soft="#E5F4EC",
                  teal="#0F7C83", teal_soft="#E3F5F6", red="#C93A40"),
    "dark": dict(bg="#15141B", fg="#EEECF5", muted="#9C98AF", line="#2C2A36", card="#1E1D26",
                 accent="#A48BFF", accent_soft="#2C2643", green="#5CC892", green_soft="#16301F",
                 teal="#5BC9CF", teal_soft="#14302F", red="#F07C80"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

TEXT = {
    "en": dict(
        eyebrow="OBSIDIAN PLUGIN · RUNS ON YOUR COMPUTER",
        line1="Paste a video link.", line2="Get a finished note.",
        small="YouTube · Bilibili · local files · transcripts",
        desc="Video Summary turns a video link into an Obsidian note. A finished job for a TED talk sits above the note it wrote: a summary and key points.",
        done="Done", took="1m 08s", summary="Summary",
        body=["Tim Urban explains procrastination as a", "conflict between a Rational Decision-Maker,", "an Instant Gratification Monkey…"],
        key="Key points",
        cards=[("Any source", "Links, recordings or a transcript."),
               ("A finished note", "Summary, key points, transcript."),
               ("Your own backend", "On your computer, with your keys.")],
        cards_title="What Video Summary does",
    ),
    "zh": dict(
        eyebrow="OBSIDIAN 插件 · 在你自己的电脑上运行",
        line1="贴一个视频链接，", line2="拿到一篇整理好的笔记。",
        small="YouTube · B 站 · 本地文件 · 文稿",
        desc="Video Summary 把视频链接变成 Obsidian 笔记。上面是一条 TED 演讲的完成任务，下面是它写出的笔记：总结和要点。",
        done="完成", took="1分08秒", summary="总结",
        body=["Tim Urban explains procrastination as a", "conflict between a Rational Decision-Maker,", "an Instant Gratification Monkey…"],
        key="Key points",
        cards=[("什么都能放", "链接、录音录像，或者一份文稿。"),
               ("直接成笔记", "总结、要点和完整文稿。"),
               ("后端在你手里", "在自己电脑上跑，用自己的密钥。")],
        cards_title="Video Summary 能做什么",
    ),
}

HERO = """<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="t d">
  <title id="t">Video Summary</title>
  <desc id="d">{desc}</desc>
  <rect width="1200" height="400" rx="28" fill="{bg}"/>
  <g font-family="{sans}">
    <text x="64" y="118" font-family="{mono}" font-size="17" letter-spacing="2" fill="{accent}">{eyebrow}</text>
    <text x="62" y="196" font-size="64" font-weight="700" letter-spacing="-1.5" fill="{fg}">Video Summary</text>
    <text x="64" y="252" font-size="29" fill="{fg}">{line1}</text>
    <text x="64" y="292" font-size="29" fill="{muted}">{line2}</text>
    <text x="64" y="346" font-family="{mono}" font-size="17" fill="{muted}">{small}</text>
  </g>
  <g font-family="{sans}">
    <rect x="700" y="48" width="436" height="304" rx="20" fill="{card}" stroke="{line}"/>
    <rect x="724" y="70" width="388" height="66" rx="14" fill="{bg}" stroke="{line}"/>
    <rect x="738" y="82" width="74" height="42" rx="8" fill="{red}" opacity="0.85"/>
    <path d="M769 95 L769 111 L782 103 Z" fill="#FFFFFF"/>
    <text x="826" y="99" font-size="17" font-weight="600" fill="{fg}">Inside the Mind of a…</text>
    <text x="826" y="122" font-family="{mono}" font-size="15" fill="{muted}">TED · {took}</text>
    <rect x="1040" y="90" width="58" height="26" rx="13" fill="{green_soft}"/>
    <text x="1069" y="108" font-size="15" text-anchor="middle" fill="{green}">{done}</text>
    <rect x="724" y="152" width="388" height="128" rx="12" fill="{teal_soft}"/>
    <text x="744" y="182" font-size="17" font-weight="600" fill="{teal}">{summary}</text>
    <text x="744" y="210" font-size="15" fill="{fg}">{b0}</text>
    <text x="744" y="232" font-size="15" fill="{fg}">{b1}</text>
    <text x="744" y="254" font-size="15" fill="{fg}">{b2}</text>
    <text x="724" y="312" font-size="20" font-weight="700" fill="{fg}">{key}</text>
    <rect x="724" y="326" width="300" height="8" rx="4" fill="{line}"/>
  </g>
</svg>
"""


def glyph(i, x, y, c):
    if i == 0:  # link, file, text: three inputs
        return (f'<rect x="{x+10}" y="{y+12}" width="28" height="6" rx="3" fill="{c["accent"]}"/>'
                f'<rect x="{x+10}" y="{y+22}" width="20" height="6" rx="3" fill="{c["muted"]}"/>'
                f'<rect x="{x+10}" y="{y+32}" width="24" height="6" rx="3" fill="{c["muted"]}"/>')
    if i == 1:  # a note with a summary block
        return (f'<rect x="{x+12}" y="{y+9}" width="24" height="30" rx="4" fill="none" stroke="{c["accent"]}" stroke-width="2.5"/>'
                f'<rect x="{x+16}" y="{y+15}" width="16" height="8" rx="2" fill="{c["teal"]}"/>'
                f'<rect x="{x+16}" y="{y+27}" width="12" height="3" rx="1.5" fill="{c["muted"]}"/>')
    return (f'<rect x="{x+10}" y="{y+12}" width="28" height="18" rx="4" fill="none" stroke="{c["accent"]}" stroke-width="2.5"/>'
            f'<path d="M{x+18} {y+37} H{x+30} M{x+24} {y+30} V{y+37}" stroke="{c["accent"]}" stroke-width="2.5" stroke-linecap="round"/>')


def cards(t, c):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="190" viewBox="0 0 1200 190" role="img" aria-labelledby="t d">',
             f'<title id="t">{t["cards_title"]}</title>',
             '<desc id="d">' + " ".join(f"{a}: {b}" for a, b in t["cards"]) + '</desc>',
             f'<g font-family="{SANS}">']
    for i, (title, body) in enumerate(t["cards"]):
        x = 24 + i * 392
        parts.append(f'<rect x="{x}" y="16" width="368" height="158" rx="22" fill="{c["bg"]}" stroke="{c["line"]}"/>')
        parts.append(f'<rect x="{x+28}" y="44" width="48" height="48" rx="14" fill="{c["accent_soft"]}"/>')
        parts.append(glyph(i, x + 28, 44, c))
        parts.append(f'<text x="{x+96}" y="78" font-size="27" font-weight="700" fill="{c["fg"]}">{title}</text>')
        parts.append(f'<text x="{x+28}" y="138" font-size="20" fill="{c["muted"]}">{body}</text>')
    parts.append('</g></svg>\n')
    return "\n".join(parts)


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent
    for lang, t in TEXT.items():
        suffix = "" if lang == "en" else "-zh"
        for name, c in THEMES.items():
            b = dict(zip(("b0", "b1", "b2"), t["body"]))
            fields = {k: v for k, v in t.items() if isinstance(v, str)}
            (out / f"hero{suffix}-{name}.svg").write_text(HERO.format(sans=SANS, mono=MONO, **fields, **b, **c), encoding="utf-8")
            (out / f"cards{suffix}-{name}.svg").write_text(cards(t, c), encoding="utf-8")
    print("wrote", sorted(p.name for p in out.glob("*.svg")))
