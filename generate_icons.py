"""
生成浏览器扩展所需的 PNG 图标文件。
需要安装 Pillow: pip install Pillow
"""
from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    """创建指定尺寸的图标"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 背景圆角矩形
    margin = size // 8
    bg_color = (26, 115, 232, 255)  # Google Blue
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 6,
        fill=bg_color,
    )

    # 绘制 "P" 字母（代表 Paper/评语）
    font_size = size // 2
    try:
        # 尝试使用系统字体
        font = ImageFont.truetype("arial.ttf", font_size)
    except (IOError, OSError):
        try:
            font = ImageFont.truetype("C:\\Windows\\Fonts\\msyh.ttc", font_size)
        except (IOError, OSError):
            font = ImageFont.load_default()

    # 文字居中
    text = "评"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (size - text_w) // 2
    y = (size - text_h) // 2 - 2
    draw.text((x, y), text, fill=(255, 255, 255, 255), font=font)

    img.save(output_path, "PNG")
    print(f"  ✓ 已生成: {output_path} ({size}x{size})")

def main():
    icons_dir = os.path.join(os.path.dirname(__file__), "icons")
    os.makedirs(icons_dir, exist_ok=True)

    sizes = [16, 48, 128]
    for size in sizes:
        output_path = os.path.join(icons_dir, f"icon{size}.png")
        create_icon(size, output_path)

    print(f"\n✅ 图标已生成到: {icons_dir}")

if __name__ == "__main__":
    main()
