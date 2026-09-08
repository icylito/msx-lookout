from PIL import Image

def bbox_diff_from(im, bg, tol):
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > tol:
                minx = min(minx, x); miny = min(miny, y)
                maxx = max(maxx, x); maxy = max(maxy, y)
    return (minx, miny, maxx, maxy)

# ---- 1. app icon: crop the rounded-square icon out of "App Icon View.png" ----
im = Image.open("pics/App Icon View.png").convert("RGB")
bg = im.getpixel((5, 5))
box = bbox_diff_from(im, bg, 30)
pad = 4
box = (max(0, box[0]-pad), max(0, box[1]-pad), min(im.width, box[2]+pad), min(im.height, box[3]+pad))
icon = im.crop(box)
# make it square (pad shorter side) so it isn't stretched
w, h = icon.size
side = max(w, h)
sq = Image.new("RGB", (side, side), icon.getpixel((2, 2)))
sq.paste(icon, ((side - w)//2, (side - h)//2))
sq.save("icon_512.png")
for size in (256, 192, 64, 32):
    sq.resize((size, size), Image.LANCZOS).save(f"icon_{size}.png")
print("icon box:", box, "square size:", sq.size)

# ---- 2. header mark: crop just the graphic (above the wordmark) out of Logo.png, key white to alpha ----
logo = Image.open("pics/Logo.png").convert("RGB")
bg2 = logo.getpixel((5, 5))
box2 = bbox_diff_from(logo, bg2, 25)
print("full logo box (graphic+text):", box2, "logo size:", logo.size)
