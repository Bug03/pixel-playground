// Pixel Playground — Owlet Channel
// A 2D pixel world where animated characters (one per user, eventually) roam,
// jump, attack and collect coins. This file is the single-player foundation.

(async () => {
    const ASSET_DIR = './assets/2 Owlet_Monster/';
    const BUBBLE_DIR = './assets/Bubble chat/';

    // ---- App ----
    const app = new PIXI.Application();
    await app.init({
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: 0x2c3e50,
        antialias: false, // crisp pixels
    });
    document.body.appendChild(app.canvas);

    // ---- Asset loading: slice a horizontal strip into N frame textures ----
    // Sheets are named `..._<N>.png` where N is the frame count; every frame is 32x32.
    async function loadStrip(file, frameCount) {
        const base = await PIXI.Assets.load(ASSET_DIR + file);
        base.source.scaleMode = 'nearest'; // pixel-perfect upscaling
        const fw = base.width / frameCount;
        const fh = base.height;
        const frames = [];
        for (let i = 0; i < frameCount; i++) {
            frames.push(new PIXI.Texture({
                source: base.source,
                frame: new PIXI.Rectangle(i * fw, 0, fw, fh),
            }));
        }
        return frames;
    }

    // Owlet Monster animation set (file, frameCount)
    const anims = {
        idle:   await loadStrip('Owlet_Monster_Idle_4.png', 4),
        walk:   await loadStrip('Owlet_Monster_Walk_6.png', 6),
        run:    await loadStrip('Owlet_Monster_Run_6.png', 6),
        jump:   await loadStrip('Owlet_Monster_Jump_8.png', 8),
        attack: await loadStrip('Owlet_Monster_Attack1_4.png', 4),
    };
    const dustJump = await loadStrip('Double_Jump_Dust_5.png', 5);
    const dustRun  = await loadStrip('Walk_Run_Push_Dust_6.png', 6);

    // Chat bubble textures (small / medium / big, picked by message length).
    async function loadBubble(file) {
        const tex = await PIXI.Assets.load(BUBBLE_DIR + file);
        tex.source.scaleMode = 'nearest';
        return tex;
    }
    const bubbleTex = {
        small:  await loadBubble('Small_bubble.png'),
        medium: await loadBubble('Medium_bubble.png'),
        big:    await loadBubble('Big_bubble.png'),
    };

    const SCALE = 4;          // 32px sprite -> 128px on screen
    const FRAME = 32 * SCALE; // rendered size

    // --- 1. Background Grid ---
    const bg = new PIXI.Graphics();
    for (let i = 0; i < app.screen.width; i += 50) bg.moveTo(i, 0).lineTo(i, app.screen.height);
    for (let j = 0; j < app.screen.height; j += 50) bg.moveTo(0, j).lineTo(app.screen.width, j);
    bg.stroke({ width: 1, color: 0x4a6278, alpha: 0.5 });
    app.stage.addChild(bg);

    // ---- Game State & UI ----
    let isPlaying = false;
    let score = 0;
    const coins = [];

    const scoreStyle = new PIXI.TextStyle({ fill: 0xffd700, fontSize: 24, fontWeight: 'bold' });
    const scoreText = new PIXI.Text({ text: 'Score: 0', style: scoreStyle });
    scoreText.x = 20;
    scoreText.y = 20;
    scoreText.visible = false;
    app.stage.addChild(scoreText);

    // ---- Coins ----
    function spawnCoin() {
        const coin = new PIXI.Graphics();
        coin.circle(0, 0, 10).fill(0xffd700).stroke({ width: 2, color: 0xffaa00 });
        coin.x = Math.random() * (app.screen.width - 100) + 50;
        coin.y = Math.random() * (app.screen.height - 150) + 80;
        coin.baseY = coin.y;       // for bobbing
        coin.bob = Math.random() * Math.PI * 2;
        app.stage.addChild(coin);
        coins.push(coin);
    }

    // ---- 2. Selection Menu ----
    const selectionMenu = new PIXI.Container();
    app.stage.addChild(selectionMenu);

    const textStyle = new PIXI.TextStyle({ fill: 0xffffff, fontSize: 32, fontFamily: 'Arial' });
    const instructionText = new PIXI.Text({ text: 'Pick your Owlet to enter the channel!', style: textStyle });
    instructionText.anchor.set(0.5);
    instructionText.x = app.screen.width / 2;
    instructionText.y = app.screen.height * 0.22;
    selectionMenu.addChild(instructionText);

    const colors = [0xffffff, 0xff9b9b, 0x9bffb0, 0x9bc4ff];
    colors.forEach((color, index) => {
        const choice = new PIXI.AnimatedSprite(anims.idle);
        choice.anchor.set(0.5);
        choice.tint = color;
        choice.scale.set(SCALE);
        choice.animationSpeed = 0.12;
        choice.play();
        choice.x = (app.screen.width / 2) - 225 + (index * 150);
        choice.y = app.screen.height / 2;
        choice.eventMode = 'static';
        choice.cursor = 'pointer';
        choice.on('pointerover', () => choice.scale.set(SCALE * 1.15));
        choice.on('pointerout', () => choice.scale.set(SCALE));
        choice.on('pointerdown', () => startGame(color));
        selectionMenu.addChild(choice);
    });

    // ---- 3. Player Setup ----
    // The player's "ground position" (gx, gy) lives on the floor plane.
    // A visual jump offset lifts the sprite while gx/gy keep driving coin pickup,
    // so jumping is expressive without breaking the top-down playground.
    const player = {
        gx: app.screen.width / 2,
        gy: app.screen.height / 2,
        facing: 1,            // 1 = right, -1 = left
        jumpY: 0,             // current visual lift (px)
        jumpVel: 0,           // vertical velocity of the hop
        jumps: 0,             // jumps used since leaving the ground
        airborne: false,
        attacking: false,
        attackTimer: 0,
        runDustTimer: 0,      // throttles the running dust trail
        bubble: null,         // active chat bubble (one at a time)
        color: 0xffffff,
    };

    const shadow = new PIXI.Graphics();
    shadow.ellipse(0, 0, FRAME * 0.22, FRAME * 0.08).fill({ color: 0x000000, alpha: 0.3 });
    shadow.visible = false;
    app.stage.addChild(shadow);

    const sprite = new PIXI.AnimatedSprite(anims.idle);
    sprite.anchor.set(0.5, 0.5);
    sprite.scale.set(SCALE);
    sprite.animationSpeed = 0.15;
    sprite.visible = false;
    sprite.play();
    app.stage.addChild(sprite);

    // Chat bubbles render above everything else.
    const chatLayer = new PIXI.Container();
    app.stage.addChild(chatLayer);

    // Track current animation so we don't restart it every frame.
    let currentAnim = 'idle';
    function setAnim(name, { loop = true, speed = 0.15 } = {}) {
        if (currentAnim === name) return;
        currentAnim = name;
        sprite.textures = anims[name];
        sprite.loop = loop;
        sprite.animationSpeed = speed;
        sprite.gotoAndPlay(0);
    }

    // ---- Input ----
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {           // open chat (handled before game keys)
            if (isPlaying && !chatOpen) openChat();
            return;
        }
        if (chatOpen) return;              // typing: ignore game controls
        const key = e.key.toLowerCase();
        if (key === 'shift') keys.shift = true;
        else if (keys.hasOwnProperty(key)) keys[key] = true;
        else if (e.code === 'Space') { e.preventDefault(); tryJump(); }
        else if (key === 'j') tryAttack();
    });
    window.addEventListener('keyup', (e) => {
        if (chatOpen) return;
        const key = e.key.toLowerCase();
        if (key === 'shift') keys.shift = false;
        else if (keys.hasOwnProperty(key)) keys[key] = false;
    });
    app.canvas.addEventListener('pointerdown', () => { if (isPlaying) tryAttack(); });

    // ---- Actions ----
    const GRAVITY = 0.9;
    const JUMP_POWER = 16;

    function tryJump() {
        if (!isPlaying || player.jumps >= 2) return;
        player.jumpVel = JUMP_POWER;
        player.airborne = true;
        if (player.jumps === 1) spawnDust(dustJump, player.gx, player.gy); // double-jump puff
        player.jumps++;
    }

    function tryAttack() {
        if (!isPlaying || player.attacking) return;
        player.attacking = true;
        player.attackTimer = anims.attack.length / 0.35; // frames-worth of ticks
    }

    // Generic one-shot dust puff. `dir` flips it; (x, y) is where it lands.
    function spawnDust(frames, x, y, dir = player.facing, speed = 0.3, scale = SCALE) {
        const dust = new PIXI.AnimatedSprite(frames);
        dust.anchor.set(0.5);
        dust.scale.set(scale);
        dust.scale.x = scale * dir;
        dust.x = x;
        dust.y = y;
        dust.animationSpeed = speed;
        dust.loop = false;
        dust.onComplete = () => dust.destroy();
        dust.play();
        app.stage.addChildAt(dust, app.stage.getChildIndex(sprite)); // behind player
    }

    // ---- Chat ----
    // Geometry measured from the bubble PNGs (all 356px wide). The tail tip is
    // NOT centered, so we anchor each bubble at its tail so it points at the head.
    const BUBBLE_W = 356;
    const BUBBLE_SCALE = 0.6;
    const BUBBLES = {
        small:  { tex: bubbleTex.small,  h: 152, tailFracX: 0.824, bodyCyFrac: 0.451 },
        medium: { tex: bubbleTex.medium, h: 194, tailFracX: 0.785, bodyCyFrac: 0.461 },
        big:    { tex: bubbleTex.big,    h: 249, tailFracX: 0.709, bodyCyFrac: 0.470 },
    };
    const chatStyle = new PIXI.TextStyle({
        fill: 0x2b2b2b,
        fontSize: 15,
        fontFamily: 'Courier New, monospace',
        fontWeight: 'bold',
        align: 'center',
        wordWrap: true,
        breakWords: true,                 // wrap long unbroken strings too
        wordWrapWidth: (342 - 13 - 24) * BUBBLE_SCALE, // inner white width, minus padding
    });

    // displayMessage() is transport-agnostic: a local send calls it directly,
    // and a future WebSocket layer would call it for messages from other users.
    function displayMessage(message) {
        const text = String(message).trim();
        if (!text) return;

        // Replace any existing bubble for this player.
        if (player.bubble) { player.bubble.container.destroy(); player.bubble = null; }

        const label = new PIXI.Text({ text, style: chatStyle });
        label.anchor.set(0.5);

        // Pick bubble art by how many lines the text wraps to.
        const lines = Math.max(1, Math.round(label.height / (chatStyle.fontSize * 1.2)));
        const cfg = lines <= 1 ? BUBBLES.small : lines <= 2 ? BUBBLES.medium : BUBBLES.big;

        const back = new PIXI.Sprite(cfg.tex);
        back.anchor.set(cfg.tailFracX, 1); // tail tip sits at the container origin
        back.scale.set(BUBBLE_SCALE);

        // Center the text on the white body (origin is at the tail, so offset across).
        label.x = (0.5 - cfg.tailFracX) * BUBBLE_W * BUBBLE_SCALE;
        label.y = (cfg.bodyCyFrac - 1) * cfg.h * BUBBLE_SCALE;

        const container = new PIXI.Container();
        container.addChild(back, label);
        chatLayer.addChild(container);

        // lifespan scales with message length, then fades out at the end.
        const life = Math.min(2500 + text.length * 55, 7000);
        player.bubble = { container, life, maxLife: life, fade: 800 };
    }

    // ---- Chat input (DOM overlay) ----
    const chatInput = document.getElementById('chat-input');
    let chatOpen = false;

    function openChat() {
        chatOpen = true;
        for (const k in keys) keys[k] = false; // stop any held movement
        chatInput.style.display = 'block';
        chatInput.value = '';
        chatInput.focus();
    }
    function closeChat() {
        chatOpen = false;
        chatInput.blur();
        chatInput.style.display = 'none';
    }
    chatInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            displayMessage(chatInput.value);
            closeChat();
        } else if (e.key === 'Escape') {
            closeChat();
        }
    });

    // ---- Start ----
    function startGame(selectedColor) {
        selectionMenu.visible = false;
        player.color = selectedColor;
        sprite.tint = selectedColor;
        sprite.visible = true;
        shadow.visible = true;
        scoreText.visible = true;
        for (let i = 0; i < 6; i++) spawnCoin();
        isPlaying = true;
    }

    // ---- 4. Game Loop ----
    const WALK_SPEED = 3;
    const RUN_SPEED = 6;

    app.ticker.add((ticker) => {
        if (!isPlaying) return;
        const delta = ticker.deltaTime;

        // --- Horizontal/vertical ground movement ---
        const running = keys.shift;
        const speed = running ? RUN_SPEED : WALK_SPEED;
        let dx = 0, dy = 0;
        if (keys.w) dy -= 1;
        if (keys.s) dy += 1;
        if (keys.a) dx -= 1;
        if (keys.d) dx += 1;

        const moving = dx !== 0 || dy !== 0;
        if (moving) {
            const len = Math.hypot(dx, dy) || 1;
            player.gx += (dx / len) * speed * delta;
            player.gy += (dy / len) * speed * delta;
            if (dx !== 0) player.facing = dx > 0 ? 1 : -1;
        }

        // --- Running dust trail: puffs kick up behind the feet while grounded ---
        player.runDustTimer -= delta;
        if (running && moving && !player.airborne && player.runDustTimer <= 0) {
            spawnDust(
                dustRun,
                player.gx - player.facing * FRAME * 0.18, // behind the feet
                player.gy + FRAME * 0.28,
                player.facing,
                0.35,
                SCALE * 0.7,
            );
            player.runDustTimer = 9; // ~ every 9 ticks
        }

        // Keep player inside the screen
        const m = FRAME * 0.3;
        player.gx = Math.max(m, Math.min(app.screen.width - m, player.gx));
        player.gy = Math.max(m, Math.min(app.screen.height - m, player.gy));

        // --- Jump physics (visual lift) ---
        if (player.airborne) {
            player.jumpY += player.jumpVel * delta;
            player.jumpVel -= GRAVITY * delta;
            if (player.jumpY <= 0) {
                player.jumpY = 0;
                player.jumpVel = 0;
                player.airborne = false;
                player.jumps = 0;
            }
        }

        // --- Attack timer ---
        if (player.attacking) {
            player.attackTimer -= delta;
            if (player.attackTimer <= 0) player.attacking = false;
        }

        // --- Animation state machine (priority: attack > jump > run/walk > idle) ---
        if (player.attacking) {
            setAnim('attack', { loop: true, speed: 0.35 });
        } else if (player.airborne) {
            setAnim('jump', { loop: false, speed: 0.25 });
        } else if (moving) {
            setAnim(running ? 'run' : 'walk', { speed: running ? 0.3 : 0.18 });
        } else {
            setAnim('idle', { speed: 0.12 });
        }

        // --- Apply transforms ---
        sprite.x = player.gx;
        sprite.y = player.gy - player.jumpY;
        sprite.scale.x = SCALE * player.facing;
        sprite.scale.y = SCALE;

        // Shadow shrinks as the player rises
        const lift = Math.min(player.jumpY / 120, 1);
        shadow.x = player.gx;
        shadow.y = player.gy + FRAME * 0.32;
        shadow.scale.set(1 - lift * 0.4);
        shadow.alpha = 0.3 * (1 - lift * 0.5);

        // --- Coins: bob + collision (uses ground position) ---
        for (let i = coins.length - 1; i >= 0; i--) {
            const coin = coins[i];
            coin.bob += 0.08 * delta;
            coin.y = coin.baseY + Math.sin(coin.bob) * 4;

            const cdx = player.gx - coin.x;
            const cdy = player.gy - coin.y;
            if (Math.hypot(cdx, cdy) < 40) {
                coin.destroy();
                coins.splice(i, 1);
                score += 10;
                scoreText.text = `Score: ${score}`;
                spawnCoin();
            }
        }

        // --- Chat bubble: follow the head, then fade out gradually ---
        if (player.bubble) {
            const b = player.bubble;
            b.container.x = sprite.x;                // tail (anchor) points down at head
            b.container.y = sprite.y - FRAME * 0.34; // tail tip just above the head
            b.life -= ticker.deltaMS;
            // alpha eases from 1 -> 0 over the last `fade` ms
            b.container.alpha = Math.max(0, Math.min(1, b.life / b.fade));
            if (b.life <= 0) {
                b.container.destroy();
                player.bubble = null;
            }
        }
    });

    // ---- Keep canvas full-screen on resize ----
    window.addEventListener('resize', () => {
        app.renderer.resize(window.innerWidth, window.innerHeight);
    });
})();
