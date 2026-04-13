"""
og-image.svg → og-image.png 변환
pip install cairosvg
"""
try:
    import cairosvg
    cairosvg.svg2png(
        url="public/og-image.svg",
        write_to="public/og-image.png",
        output_width=1200,
        output_height=630,
    )
    print("✅ og-image.png 생성 완료")
except ImportError:
    print("cairosvg 없음. 아래 방법으로 변환하세요:")
    print("  pip install cairosvg")
    print("  또는 https://cloudconvert.com/svg-to-png 에서 변환")
