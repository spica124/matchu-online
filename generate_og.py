"""
og-image.png 생성 스크립트
pip install pillow requests
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
import urllib.request

W, H = 1200, 630

def get_font(size):
    nanum_path = "fonts/NanumGothicRounded.ttf"
    if not os.path.exists(nanum_path):
        os.makedirs("fonts", exist_ok=True)
        try:
            print("  나눔고딕라운드 폰트 다운로드 중...")
            urllib.request.urlretrieve(
                "https://github.com/google/fonts/raw/main/ofl/nanumgothicrounded/NanumGothicRounded.ttf",
                nanum_path
            )
        except:
            pass

    for path in [nanum_path, "C:/Windows/Fonts/malgunbd.ttf", "C:/Windows/Fonts/malgun.ttf"]:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except:
                continue
    return ImageFont.load_default()

def generate():
    print("OG 이미지 생성 중...")

    canvas = Image.new("RGBA", (W, H), (18, 18, 18, 255))

    # 오른쪽 글로우
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(500, 0, -10):
        alpha = int(35 * (1 - i / 500))
        gd.ellipse([W - i, -i//3, W + i//2, i * 1.4], fill=(232, 64, 94, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(50))
    canvas = Image.alpha_composite(canvas, glow)

    draw = ImageDraw.Draw(canvas)

    # 상단 바
    for x in range(W):
        t = x / W
        r = int(232 + (255 - 232) * t)
        g = int(64  + (82  - 64)  * t)
        b = int(94  + (115 - 94)  * t)
        draw.line([(x, 0), (x, 5)], fill=(r, g, b, 255))

    # 타이틀
    draw.text((80, 190), "마추기온라인", font=get_font(108), fill=(255, 255, 255, 255))

    # 구분선
    for x in range(80, 720):
        t = (x - 80) / 640
        alpha = int(255 * (1 - t * 0.6))
        draw.line([(x, 330), (x, 333)], fill=(232, 64, 94, alpha))

    # 설명
    draw.text((80, 355), "친구들과 실시간으로 즐기는 멀티플레이 퀴즈 게임", font=get_font(30), fill=(150, 150, 150, 255))

    # URL
    draw.text((80, 578), "matchu-online.onrender.com", font=get_font(22), fill=(80, 80, 80, 255))

    out = canvas.convert("RGB")
    out.save("public/og-image.png", "PNG", quality=95)
    print("✅ public/og-image.png 생성 완료!")

if __name__ == "__main__":
    generate()
