# 『Strike Lane』ボウリング物理演算 完全解説仕様書

本作（Strike Lane）で実装されているボウリングの物理シミュレーションについて、座標系の定義から投球のスワイプ解析、ボールの運動力学、ボールとピンの衝突、ピン同士の連鎖倒壊（ドミノ・弾性衝突）、3D遠近法投影まで、すべての数理モデルとコード実装を日本語で詳しく解説します。

---

## 目次
1. [座標系とレーンパースペクティブ（透視投影）](#1-座標系とレーンパースペクティブ透視投影)
2. [スワイプ入力と投球パラメータ解析（JGuide）](#2-スワイプ入力と投球パラメータ解析jguide)
3. [ボールの運動物理（Ball Physics）](#3-ボールの運動物理ball-physics)
4. [ボールとピンの第1種衝突（Ball-Pin Collision）](#4-ボールとピンの第1種衝突ball-pin-collision)
5. [ピン同士の連鎖衝突物理（Pin-Pin Chain Collision）](#5-ピン同士の連鎖衝突物理pin-pin-chain-collision)
6. [倒れたピンの3次元挙動とフロア反射（Pin 3D Dynamics）](#6-倒れたピンの3次元挙動とフロア反射pin-3d-dynamics)
7. [ガター判定と物理制約](#7-ガター判定と物理制約)
8. [物理パラメータ一覧表](#8-物理パラメータ一覧表)

---

## 1. 座標系とレーンパースペクティブ（透視投影）

ゲーム内の物理シミュレーションは、画面のピクセル解像度（スマホやPC）に依存しないよう、**正規化されたレーン空間（Normalized Lane Coordinates）** 上で行われています。

### 1.1 正規化座標系
- **横軸 $nx$（Lateral Position）**:
  - レーン中央が `0.0`
  - レーン左端が `-0.5`
  - レーン右端が `+0.5`
  - ガター領域： $|nx| > 0.50$
- **縦軸 $ny$（Down-Lane Position）**:
  - ファールライン側（手前・投球位置）： `ny = 0.03`
  - ピンデッキ（ピンが配置されている奥）： `ny = 0.855 ～ 0.950`
  - レーン脱出境界： `ny >= 1.08`
- **高さ軸 $pz$（Vertical Height）**:
  - フロア面（レーン床）： `pz = 0`
  - 鉛直上向き： 正の方向

### 1.2 ピンの配置幾何学（PIN_DEFS）
正三角形のグリッド配列（10本のピン）が正規化座標上に精密に配置されています：
- **Row 1（1番ピン・ヘッドピン）**: $(nx, ny) = (0, 0.855)$
- **Row 2（2番, 3番ピン）**: $nx = \pm 0.085, ny = 0.888$
- **Row 3（4番, 5番, 6番ピン）**: $nx = \{-0.170, 0, +0.170\}, ny = 0.920$
- **Row 4（7番, 8番, 9番, 10番ピン）**: $nx = \{-0.255, -0.085, +0.085, +0.255\}, ny = 0.950$

### 1.3 画面への投影変換（Renderer.w2s）
3Dの透視投影効果（奥に行くほどレーン幅が狭まり、ピンが小さく見える）を以下の一次線形補間（Linear Interpolation）でスクリーン座標 $(sx, sy)$ に変換します：

$$sy = botY + (topY - botY) \times ny$$

$$hw(ny) = botHW + (topHW - botHW) \times ny$$

$$sx = \frac{cw}{2} + \frac{nx \times hw(ny)}{0.5}$$

$$scale(ny) = \max(1.0 - ny \times 0.50, 0.35)$$

- $cw, ch$: キャンバスの幅・高さ
- $botY, topY$: レーン手前端（約90.5%高）、奥端（約20%高）
- $botHW, topHW$: レーン手前の半幅、奥の半幅
- $scale$: 遠近感によるピン・ボールの縮尺係数（奥に行くと最大35%まで縮小）

---

## 2. スワイプ入力と投球パラメータ解析（JGuide）

指のスワイプ操作から「球速」「左右の打ち出しズレ」「フック（スピン）の曲がり」の3大要素をリアルタイムで数理解析します。

### 2.1 遠近法追従ガイド（Perspective JGuide）
プレイヤーの狙い角（エイム位置 $aimNx$）からピンへ向かう直線は、遠近法によって画面上では末広がりの斜線になります。
- `setAim(aimNx, w2s)` により、50分割された軌道サンプル点群を生成。
- プレイヤーのスワイプ中、現在の指の高さ $y$ における理想直線のX座標 $expectedX$ を線形補間により算出します：
  $$\Delta x = touchX - expectedX(touchY)$$
  この差分が **「理想軌道からのズレ（Deviation）」** となります。

### 2.2 スワイプ速度の算出（Speed Factor）
直近のタッチ座標履歴（最大8フレーム前と直近フレーム）の時間差 $\Delta t$ と距離 $\Delta y$ から垂直スワイプ速度を算出：
$$speed = \frac{y_{prev} - y_{last}}{\Delta t}$$
$$speedFactor = \text{clamp}\left(\frac{speed}{0.65}, 0.25, 2.2\right)$$

### 2.3 打ち出しコース偏差（Deviation Factor）
スワイプ中に記録された全フレームのズレ $\Delta x$ の平均値を正規化：
$$avgDev = \frac{1}{N} \sum_{i=1}^{N} dev_i$$
$$deviationFactor = \text{clamp}\left(\frac{avgDev}{32}, -1.2, 1.2\right)$$
- 右にブレていればプラス、左にブレていればマイナス。

### 2.4 フック・カーブスピンの曲率解析（Hook Curve）
指の軌道が「途中で曲がっているか（円弧を描いているか）」を、始点（Start）、中点（Mid）、終点（End）の偏差ベクトルから2次モーメント的に評価：
$$\Delta End = dev_{last} - dev_{start}$$
$$arcMid = dev_{mid} - \frac{dev_{start} + dev_{last}}{2}$$
$$hookCurve = \text{clamp}\left(\frac{1.3 \times \Delta End + 1.6 \times arcMid}{25}, -1.5, 1.5\right)$$
- スワイプ終盤に指を左へ曲げて抜くことで、ボウリング特有の鋭い「フックボール」をスピンとして入力できます。

---

## 3. ボールの運動物理（Ball Physics）

### 3.1 打ち出し初期値の決定（Ball.launch）
スワイプ解析の結果を正規化レーン速度ベクトルに変換します：
- **初期位置**: $(nx, ny) = (aimNx, 0.03)$
- **前進初速 ($vy$)**: 
  $$vy = \text{clamp}(speedFactor \times 0.52, 0.22, 0.95)$$
- **横方向初速 ($vx$)**: 
  $$vx = deviationFactor \times 0.35 + aimNx \times 0.05$$
  （指の横ブレがボールの射出角に直接影響）
- **曲がり加速度 ($curve$)**:
  $$curve = hookCurve \times 0.48$$

### 3.2 毎フレームの運動方程式（Euler積分）
毎フレーム微小時間 $\Delta t$ ごとに状態を更新します：
1. **カーブ（求心加速度）の適用**:
   $$vx \leftarrow vx + curve \times \Delta t$$
   $$nx \leftarrow nx + vx \times \Delta t$$
   ※ ボールが奥に進むにつれて、スピンによる横滑り加速度が継続的に累積し、ボウリング特有の「最初は直進し、ピン手前でグッと曲がる」軌道が再現されます。
2. **前進運動の維持**:
   $$vy \leftarrow \max(0.20, vy)$$
   $$ny \leftarrow ny + vy \times \Delta t$$
   （ピン衝突によってボールが後退しないよう、最小前進速度 $0.20$ を保証）

---

## 4. ボールとピンの第1種衝突（Ball-Pin Collision）

ボールがピンデッキエリア（$ny \ge 0.78$）に進入すると、立っている各ピンとの衝突判定が行われます。

### 4.1 衝突検出（アスペクト比補正付き円形衝突）
縦長のレーン空間を円形として正しく計算するため、縦軸距離に $1.5$ のアスペクト比補正を適用しています：
$$\Delta x = p.nx - ball.nx$$
$$\Delta y = (p.ny - ball.ny) \times 1.5$$
$$dist = \sqrt{\Delta x^2 + \Delta y^2}$$
$$HIT\_RAD = BALL\_HIT\_RADIUS + PIN\_HIT\_RADIUS = 0.09 + 0.035 = 0.125$$
- $dist < HIT\_RAD$ のとき衝突と判定。
- $dist < HIT\_RAD \times 1.4$ のとき、ニアミスによる「ピンのぐらつき（nearMissWobble）」を誘発。

### 4.2 質量比と反発係数（Impulse-Based Elastic Collision）
ボウリングのボールはピンより遥かに重いため、現実の比率（ボール約14ポンド vs ピン約3.5ポンド = 約4:1）を考慮し、本作では迫力と貫通力を両立するため **$M_{ball} = 14.0$**、**$M_{pin} = 1.0$** に設定されています。
- 反発係数: $e = 0.45$

法線ベクトル $\vec{n} = (\Delta x / dist, \Delta y / dist)$ における相対速度 $v_n$：
$$\vec{v}_{rel} = (0 - ball.vx, 0 - ball.vy \times 1.5)$$
$$v_n = \vec{v}_{rel} \cdot \vec{n}$$
$v_n < 0$ （接近中）の場合のみ力積（Impulse）を計算：

$$j = -\frac{(1 + e) \cdot v_n}{\frac{1}{M_{ball}} + \frac{1}{M_{pin}}}$$

### 4.3 めり込み防止の位置補正（Position Correction）
$$overlap = HIT\_RAD - dist$$
$$b_{corr} = overlap \times \frac{M_{pin}}{M_{ball} + M_{pin}}$$
$$ball.nx \leftarrow ball.nx - n_x \times b_{corr}$$
$$ball.ny \leftarrow ball.ny - \frac{n_y}{1.5} \times b_{corr}$$

### 4.4 速度ベクトルと角運動量の分配
- **ボール側**: 
  $$ball.vx \leftarrow ball.vx - \frac{j \cdot n_x}{M_{ball}}$$
  $$ball.vy \leftarrow ball.vy - \frac{j \cdot n_y / 1.5}{M_{ball}}$$
  （ピンに当たることでボールはわずかに減速・コースが外側に押し出される）
- **ピン側（衝撃力積の付与）**:
  外積による回転トルク（角速度）：
  $$cross = n_x \cdot (-ball.vy \times 1.5) - n_y \cdot (-ball.vx)$$
  $$wz = cross \times (-6.0)$$
  ピンへ力積を付与：
  $$p.applyImpulse\left(\frac{j \cdot n_x}{M_{pin}}, \frac{j \cdot n_y / 1.5}{M_{pin}}, wz\right)$$

---

## 5. ピン同士の連鎖衝突物理（Pin-Pin Chain Collision）

ストライクを取るために最も重要な「倒れたピンが隣のピンをなぎ倒す」連鎖アクション（ドミノ倒し）を、毎フレーム全ピン同士のペア（$_nC_2$）でリアルタイム完全弾性・非弾性衝突判定しています。

### 5.1 ピン間衝突条件
2本のピン $p_1, p_2$ について：
- 両方ともまだ直立している場合はスキップ。
- 少なくとも一方が倒れているか、運動エネルギーを持っている場合に計算。
- ピン同士の接触半径： $HIT\_RAD = PIN\_HIT\_RADIUS \times 2 = 0.070$

### 5.2 ピン間力積方程式
- 各ピンの質量： $M_{pin} = 1.0$
- ピン同士の反発係数： $e = 0.35$ （ピン同士が激しく跳ね返りすぎず、塊となって奥や横へ転がる絶妙な減衰比）

法線方向の相対速度 $v_n$ から力積 $j$ を算出：
$$j = -\frac{(1 + e) \cdot v_n}{\frac{1}{1.0} + \frac{1}{1.0}} = -\frac{(1 + 0.35) \cdot v_n}{2}$$
$$j_x = j \cdot n_x, \quad j_y = j \cdot n_y$$

- $p_1$ が直立ピンだった場合： $p_1.applyImpulse(-j_x, -j_y / 1.5, -wz)$ （新しく倒れる）
- $p_1$ が既に飛んでいるピンの場合： 速度・スピンを更新
- $p_2$ 側も対称に力積が加算されます。

これにより、**1番ピンが3番ピンを弾き、3番ピンが6番ピン・10番ピンを弾く**という本物のボウリングと全く同じキネティクス連鎖が発生します。

---

## 6. 倒れたピンの3次元挙動とフロア反射（Pin 3D Dynamics）

ピンは倒れた瞬間、単に倒れ絵に切り替わるのではなく、**3次元の浮遊物（Rigid Body）** として上空へ打ち上げられます。

### 6.1 衝撃による打ち上げ（Upward Pop）
ピンに力積が加わると、水平方向の合成速度 $speed = \sqrt{vx^2 + vy^2}$ に応じて、鉛直方向の上向き速度 $vz$ が付与されます：
$$vz = 0.45 + speed \times 0.8 + \text{random}(0 \sim 0.3)$$
初期自転角 $rz = \text{random}(0 \sim 2\pi)$

### 6.2 3D放物線運動と重力
毎フレーム、重力加速度 $g = -3.8$ が適用されます：
$$vz \leftarrow vz + (-3.8) \times \Delta t$$
$$px \leftarrow px + vx \times \Delta t$$
$$py \leftarrow py + vy \times \Delta t$$
$$pz \leftarrow pz + vz \times \Delta t$$
$$rz \leftarrow rz + wz \times \Delta t \quad \text{（空中の激しい回転）}$$

### 6.3 フロアデッキでのバウンドと摩擦減衰（Floor Bounce & Rolling）
ピンの高さ $pz < 0$（床面に激突）となった瞬間：
$$pz = 0$$
$$vz \leftarrow -vz \times 0.42 \quad \text{（非弾性バウンド：反発率42%）}$$
同時に、床との強い摩擦により水平速度・回転速度が急激に減衰：
$$vx \leftarrow vx \times 0.58$$
$$vy \leftarrow vy \times 0.58$$
$$wz \leftarrow wz \times 0.58$$
これにより、高く跳ね上がったピンがデッキに落ちたあと、「ゴロゴロと重く転がりながら他のピンを巻き込む」リアルな挙動が生まれます。

---

## 7. ガター判定と物理制約

### 7.1 ガター溝への転落条件
ボールの横座標がレーン幅を超えた場合（$|nx| > 0.50$）：
- `inGutter = true`
- 横速度 $vx = 0$
- カーブ加速度 $curve = 0$
- ガターの中心位置 $nx = \text{sign}(nx) \times 0.51$ にボールを拘束。
- ガター効果音（ドスンという低い溝落ち音）を再生。

### 7.2 ガター拘束
一度ガターに落ちたボールは、横方向の速度とカーブが即座にゼロにリセットされ、溝（$nx = \pm 0.51$）に沿って真っ直ぐ奥へ滑り落ちます。ピンエリア（$ny \ge 0.78$）に進入しても、ピン衝突判定の対象外となり、ピンを倒すことはできません。

---

## 8. 物理パラメータ一覧表

| パラメータ名 | 設定値 | 単位/基準 | 物理的役割・意味 |
|---|---|---|---|
| `BALL_MASS` | `14.0` | 相対比 | ボールの質量。ピンを力強く弾き飛ばす貫通力 |
| `PIN_MASS` | `1.0` | 相対比 | ピンの質量 |
| `BALL_HIT_RADIUS` | `0.09` | レーン幅比 | ボールの衝突判定球半径 |
| `PIN_HIT_RADIUS` | `0.035` | レーン幅比 | ピンの衝突判定半径（薄い円柱相当） |
| `BALL-PIN RESTITUTION` | `0.45` | 比率 (0〜1) | ボールとピンの反発係数 |
| `PIN-PIN RESTITUTION` | `0.35` | 比率 (0〜1) | ピン同士の反発係数（適度な減衰） |
| `GRAVITY` | `-3.8` | $1/s^2$ | ピンの落下重力加速度（滞空時間を演出） |
| `PIN_BOUNCE_COEFF` | `0.42` | 比率 (0〜1) | ピンが床で跳ね返る弾性係数 |
| `PIN_FLOOR_FRICTION` | `0.58` | 1バウンド減衰 | バウンド時の横転がり摩擦減衰率 |
| `MIN_BALL_VY` | `0.20` | 正規化速度/s | 衝突時にもボールが前進し続ける最小速度 |
| `HOOK_CURVE_SCALE` | `0.48` | 加速度係数 | スワイプの指曲率からボール横加速度への変換比 |
| `ASPECT_CORRECTION` | `1.5` | 補正倍率 | 縦長画面用のアスペクト比補正（距離・速度計算） |

---

## まとめ
『Strike Lane』の物理演算エンジンは、単純な確率やアニメーション再生ではなく、**「連続的な剛体力積計算」「質量比を考慮した弾性・非弾性衝突」「重力と床面摩擦を伴う3次元ピン浮遊運動」「リアルタイムなピン同士の多体連鎖」** を数理モデルに基づいて厳密に解くことで、本物のボウリング場のダイナミックなピンアクションとフックボールの快感を再現しています。
