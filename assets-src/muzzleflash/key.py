# Key real muzzle-flash photos onto black and pack them into two atlases (premultiplied, additive):
# flash_side.png -> public/fx/muzzle-side.png, flash_front.png -> public/fx/muzzle-front.png.
# Needs python3 + numpy + ffmpeg. Put the sources next to it first (see README.md): flash/Muzzle_flash_VFX*.png|jpg
# and photos/f08.jpg ("Light 'Em Up"). Run from this folder: python3 key.py
import numpy as np, subprocess, json, sys, math
def load(path):
    p = subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',path],capture_output=True,text=True)
    s = json.loads(p.stdout)['streams'][0]; w,h = s['width'],s['height']
    raw = subprocess.run(['ffmpeg','-v','error','-i',path,'-f','rawvideo','-pix_fmt','rgba','-'],capture_output=True).stdout
    return np.frombuffer(raw,np.uint8).reshape(h,w,4).astype(np.float32)/255
def save(path, img):
    h,w,_ = img.shape
    rgb = (np.clip(img,0,1)**(1/2.2)*255+0.5).astype(np.uint8)
    subprocess.run(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{w}x{h}','-i','-',path],input=rgb.tobytes())
def lin(c): return c**2.2
def sstep(a,b,x): t=np.clip((x-a)/(b-a),0,1); return t*t*(3-2*t)
def sample(img, cx, cy, ang, length, back, half, W, H):
    # resample: output u in [0,1] maps to axis distance -back..length from the muzzle (cx,cy) along ang (deg, image coords),
    # v in [-1,1] maps to +-half perpendicular. bilinear
    a = math.radians(ang); ax, ay = math.cos(a), math.sin(a); px, py = -ay, ax
    u = np.linspace(0,1,W)[None,:]*(length+back)-back; v = np.linspace(-1,1,H)[:,None]*half
    X = cx + u*ax + v*px; Y = cy + u*ay + v*py
    h,w,_ = img.shape
    X = np.clip(X,0,w-1.001); Y = np.clip(Y,0,h-1.001)
    x0 = X.astype(int); y0 = Y.astype(int); fx = (X-x0)[...,None]; fy = (Y-y0)[...,None]
    c = img[y0,x0]*(1-fx)*(1-fy)+img[y0,x0+1]*fx*(1-fy)+img[y0+1,x0]*(1-fx)*fy+img[y0+1,x0+1]*fx*fy
    return c
def key(c, bg, lo, hi, gain=1.0):
    # c rgba 0..1 (sRGB); bg: rgb to subtract (sRGB) or 'alpha' (white background with alpha)
    rgb = lin(c[...,:3])
    if isinstance(bg,str):
        rgb = rgb*c[...,3:4]
    else:
        rgb = np.maximum(rgb - lin(np.array(bg))[None,None,:], 0)
    L = rgb@np.array([0.3,0.55,0.15])
    a = sstep(lo,hi,L)[...,None]
    return rgb*a*gain
def edge(H,W,u0=0.0,u1=0.08,u2=0.85,v=0.75):
    # soft window: fade in over the first u1 of the length (behind the muzzle nothing), fade out at the far end and the sides
    u = np.linspace(0,1,W)[None,:]; vv = np.abs(np.linspace(-1,1,H)[:,None])
    return (sstep(u0,u1,u)*(1-sstep(u2,1.0,u))*(1-sstep(v,1.0,vv)))[...,None]
def radial(N, r0=0.7):
    y,x = np.mgrid[0:N,0:N]/(N-1)*2-1; r = np.hypot(x,y)
    return (1-sstep(r0,1.0,r))[...,None]
def norm(img, q=0.995):
    m = np.quantile(img.max(-1), q); return img/max(m,1e-4)

SW,SH = 512,256
side = []
# S1: Wikimedia "Muzzle flash VFX 2" (M2 .50, CC0): flash hider at (600,230), jet to the left
im = load('flash/Muzzle_flash_VFX_2.png')
c = sample(im, 596, 232, 180, 560, 10, 150, SW, SH)
side.append(norm(key(c,[0.02,0.02,0.02],0.004,0.05))*edge(SH,SW,0.0,0.03,0.88))
# S2: "Light 'Em Up" (USMC, public domain): M2 at night, muzzle at (2800,762), flame up and right ~ -11 deg
im = load('photos/f08.jpg')
c = sample(im, 2790, 765, -11, 1050, 20, 420, SW, SH)
s2 = lin(c[...,:3]); s2 = s2*sstep(0.10,0.45,s2[...,1])[...,None]*sstep(0.02,0.25,s2.max(-1))[...,None]   # keyed on green: the red sky glow has none
vv = np.linspace(-1,1,SH)[:,None,None]
s2 *= 1-sstep(0.28,0.62,vv)          # the lit truck under the flame
side.append(norm(s2)*edge(SH,SW,0.0,0.04,0.72,0.7))
# S3: Wikimedia "Muzzle flash VFX" (CC0, white background + alpha): plume from the left, ball on the right
im = load('flash/Muzzle_flash_VFX.png')
c = sample(im, 150, 222, 0, 555, 0, 250, SW, SH)
s3 = key(c,'alpha',0.05,0.5)
sat = (s3.max(-1)-s3.min(-1))/(s3.max(-1)+1e-4)
L3 = s3.max(-1)/s3.max()
s3 *= np.maximum(0.35+0.65*sstep(0.15,0.5,sat), sstep(0.3,0.7,L3))[...,None]   # grey smoke dimmer than flame
side.append(norm(s3)*edge(SH,SW,0.0,0.06,0.9,0.6))

FN = 256
front = []
for f,cx,cy,r,bg in [('flash/Muzzle_flash_VFX_4.jpg',360,300,310,[0.03,0.03,0.03]),('flash/Muzzle_flash_VFX_5.jpg',480,440,450,[0.02,0.02,0.02]),('flash/Muzzle_flash_VFX_3.png',120,105,110,'alpha')]:
    im = load(f)
    c = sample(im, cx-r, cy, 0, 2*r, 0, r, FN, FN)
    k = key(c,bg,0.01,0.12)
    m = np.clip(k.max(-1)/max(np.quantile(k.max(-1),0.9),1e-4),0,1)
    y,x = np.mgrid[0:FN,0:FN]/(FN-1)*2-1; r2 = x*x+y*y
    # photo texture inside the clip: the unclipped part of the source where there is any
    d = m*(0.25+0.75*np.exp(-r2/0.18))*(0.85+0.15*np.clip(k.mean(-1)/max(k.mean(-1).max(),1e-4),0,1))
    d = d*radial(FN,0.6)[...,0]
    ramp = np.stack([np.clip(d*1.6,0,1), np.clip(d*1.6-0.25,0,1)**1.2, np.clip(d*1.6-0.75,0,1)*1.4],-1)
    blob = ramp
    # jets: the side flames resampled into polar coordinates around the centre, 5-7 of them
    rng = np.random.default_rng(len(front)*7+3)
    ang = np.arctan2(y,x); rr = np.sqrt(r2)
    jets = np.zeros_like(blob)
    n = rng.integers(5,8); base = rng.uniform(0,6.28)
    for j in range(n):
        a0 = base + j*6.283/n + rng.uniform(-0.3,0.3)
        L = rng.uniform(0.55,1.0); wdt = rng.uniform(0.16,0.26)
        da = np.angle(np.exp(1j*(ang-a0)))
        src = side[j % len(side)]
        u = np.clip(rr/L,0,1); v = np.clip(da/wdt*0.5+0.5,0,1)
        ui = np.clip((u*(SW-1)).astype(int),0,SW-1); vi = np.clip((v*(SH-1)).astype(int),0,SH-1)
        jets = np.maximum(jets, src[vi,ui]*((rr<L)&(np.abs(da)<wdt*2))[...,None]*(1-sstep(0.6,1.0,rr/L))[...,None])
    sc = 0.6   # the blob shrunk to the middle
    yi = np.clip(((y/sc)*0.5+0.5)*(FN-1),0,FN-1).astype(int); xi = np.clip(((x/sc)*0.5+0.5)*(FN-1),0,FN-1).astype(int)
    small = blob[yi,xi]*((np.abs(x)<sc)&(np.abs(y)<sc))[...,None]
    front.append(np.clip(np.maximum(small, jets*0.8)*radial(FN,0.8),0,1))

# atlases: side 512 x 1024 (4 rows of 512x256, row 4 empty), front 512x512 (2x2, last empty)
A = np.zeros((SH*4,SW,3),np.float32)
for i,s in enumerate(side): A[i*SH:(i+1)*SH] = s
save('flash_side.png', A)
B = np.zeros((FN*2,FN*2,3),np.float32)
for i,s in enumerate(front): B[(i//2)*FN:(i//2+1)*FN,(i%2)*FN:(i%2+1)*FN] = s
save('flash_front.png', B)
print('ok')
