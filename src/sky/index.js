/* ==========================================================================
 * Escape-From-Larpov · src/sky/index.js
 *
 * Sky subsystem: an atmosphere + two-deck cloud dome drawn as one primitive
 * centred on the camera, plus the scene's sun light.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN — fatal boot crash, black screen
 * ---------------------------------------------------------------------------
 *   ReferenceError: SKY_FRAGMENT_SHADER is not defined
 *       at SkySystem.init (index.js:171:28)
 *
 * init() referenced SKY_VERTEX_SHADER and SKY_FRAGMENT_SHADER, but neither was
 * ever declared or imported in this file: the two GLSL constants were lost in an
 * earlier bulk upload, along with the bodies the leftover stubs pointed at
 * («... дальше ваш конструктор и метод async init(ctx)»). Only two commits ever
 * touched the file, both bulk uploads, so there was no good revision to recover:
 * the shaders were rewritten from scratch and now live in ./shaders.js. They are
 * re-exported below, so any existing import of them from this module still
 * resolves.
 *
 * A second, latent black screen is fixed with it. The dome was scaled to 8000
 * while the gameplay camera's far plane is 1200 (src/core/engine.js), so every
 * dome vertex sat outside the frustum and the whole mesh was clipped away.
 * depthTest:false does not help — far-plane clipping happens in clip space,
 * before the depth test runs. The dome is sized from camera.far now, and the
 * vertex shader pins it to the far plane so its radius stops mattering.
 *
 * [X3595] The loop and derivative policy that keeps the GPU driver from
 * stalling is documented at the top of ./shaders.js and enforced by
 * assertStaticLoopBounds() below, which runs before the material is built.
 *
 * ---------------------------------------------------------------------------
 * Registry contract (src/core/registry.js)
 * ---------------------------------------------------------------------------
 *   static id = 'sky'         fetched by others via ctx.get('sky')
 *   static deps = ['render']  the renderer must exist before we init
 *   async init(ctx)           builds every resource
 *   update(dt, ctx)           once per frame, before render
 *   dispose()                 frees GPU resources
 *
 * No sibling subsystem is imported: the renderer is resolved through ctx.
 * ========================================================================== */

import * as THREE from 'three';
import { SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER } from './shaders.js';

export { SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER };

/* --------------------------------------------------------------------------
 * Procedural tiling cloud noise.
 *
 * R, G and B hold value-noise FBM at three different base frequencies, so one
 * texture read is worth three octaves in the shader. The mip pyramid is what
 * makes the shader's explicit LOD meaningful — without it, grazing rays near the
 * horizon alias into a shimmering mess.
 * ------------------------------------------------------------------------ */
export function createCloudNoiseTexture( size = 256 ) {

	const data = new Uint8Array( size * size * 4 );

	const hash = ( x, y, seed ) => {
		const s = Math.sin( x * 127.1 + y * 311.7 + seed * 74.7 ) * 43758.5453123;
		return s - Math.floor( s );
	};
	const fade = ( t ) => t * t * ( 3 - 2 * t );

	const valueNoise = ( u, v, freq, seed ) => {
		const fx = u * freq;
		const fy = v * freq;
		const ix = Math.floor( fx );
		const iy = Math.floor( fy );
		const tx = fade( fx - ix );
		const ty = fade( fy - iy );
		const wrap = ( n ) => ( ( n % freq ) + freq ) % freq;
		const x0 = wrap( ix );
		const x1 = wrap( ix + 1 );
		const y0 = wrap( iy );
		const y1 = wrap( iy + 1 );
		const a = hash( x0, y0, seed );
		const b = hash( x1, y0, seed );
		const c = hash( x0, y1, seed );
		const d = hash( x1, y1, seed );
		return ( a + ( b - a ) * tx ) * ( 1 - ty ) + ( c + ( d - c ) * tx ) * ty;
	};

	const fbm = ( u, v, base, seed ) => {
		let sum = 0;
		let amp = 0.5;
		let freq = base;
		for ( let o = 0; o < 4; o ++ ) {
			sum += valueNoise( u, v, freq, seed + o ) * amp;
			amp *= 0.5;
			freq *= 2;
		}
		return sum;
	};

	const byte = ( n ) => Math.max( 0, Math.min( 255, Math.round( n * 255 ) ) );

	for ( let y = 0; y < size; y ++ ) {
		for ( let x = 0; x < size; x ++ ) {
			const u = x / size;
			const v = y / size;
			const i = ( y * size + x ) * 4;
			data[ i + 0 ] = byte( fbm( u, v, 4, 11 ) );
			data[ i + 1 ] = byte( fbm( u, v, 8, 23 ) );
			data[ i + 2 ] = byte( fbm( u, v, 16, 37 ) );
			data[ i + 3 ] = 255;
		}
	}

	const tex = new THREE.DataTexture( data, size, size, THREE.RGBAFormat );
	tex.name = 'EFL_CloudNoise';
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.generateMipmaps = true;
	// Noise is data, not colour: it must never go through a transfer function.
	tex.colorSpace = THREE.NoColorSpace;
	tex.needsUpdate = true;
	return tex;

}

/* --------------------------------------------------------------------------
 * Quality presets. These become #defines, i.e. part of the shader permutation
 * key: STEPS is the atmosphere march, LIGHT_STEPS the in-cloud light march, and
 * CLOUDS compiles the entire cloud path in or out.
 * ------------------------------------------------------------------------ */
export const SKY_QUALITY_PRESETS = {
	low: { STEPS: 16, LIGHT_STEPS: 4, CLOUDS: 0 },
	medium: { STEPS: 28, LIGHT_STEPS: 6, CLOUDS: 1 },
	high: { STEPS: 44, LIGHT_STEPS: 8, CLOUDS: 1 },
	ultra: { STEPS: 64, LIGHT_STEPS: 12, CLOUDS: 1 },
};

/* --------------------------------------------------------------------------
 * Weather presets. rayleigh scales the molecular coefficients, mie the aerosol
 * ones, turbidity the haze on top of that. overcast is unchanged and remains the
 * default look.
 * ------------------------------------------------------------------------ */
export const SKY_WEATHER_PRESETS = {
	clear: { turbidity: 2.2, rayleigh: 1.00, mie: 0.0035, mieG: 0.76, coverage: 0.18, density: 22, exposure: 0.34 },
	hazy: { turbidity: 4.4, rayleigh: 1.20, mie: 0.0065, mieG: 0.74, coverage: 0.42, density: 32, exposure: 0.32 },
	overcast: { turbidity: 6.5, rayleigh: 1.45, mie: 0.0090, mieG: 0.72, coverage: 0.72, density: 46, exposure: 0.30 },
	storm: { turbidity: 8.5, rayleigh: 1.60, mie: 0.0125, mieG: 0.70, coverage: 0.92, density: 68, exposure: 0.22 },
};

/**
 * [X3595] Rejects any `for` loop whose bound is not a compile-time constant.
 *
 * Uppercase identifiers (STEPS, LIGHT_STEPS) and float(CONST) casts are the only
 * accepted bounds, because those are the ones that reach the compiler as
 * #defines from THREE.ShaderMaterial.defines. A uniform bound compiles into a
 * loop with a varying iteration count, and any gradient instruction inside one
 * makes the driver emit "gradient instruction used in a loop with varying
 * iteration" — a compile stall on the render thread, i.e. a hitch mid-raid.
 *
 * The regex is built per call on purpose: a module-level /g regex keeps its
 * lastIndex between calls and would silently skip half of the second shader it
 * was handed.
 */
export function assertStaticLoopBounds( source, label = 'shader' ) {

	const loopRe = /for\s*\(\s*(?:int|float|uint)\s+(\w+)\s*=\s*[^;]+;\s*\1\s*<=?\s*([A-Za-z_][\w.()]*)/g;
	const bad = [];
	let m;

	while ( ( m = loopRe.exec( String( source ) ) ) !== null ) {
		const bound = m[ 2 ];
		const isConstant = /^[A-Z0-9_]+$/.test( bound ) || /^float\(\s*[A-Z0-9_]+\s*\)$/.test( bound );
		if ( ! isConstant ) bad.push( bound );
	}

	if ( bad.length ) {
		const msg = '[X3595] ' + label + ': dynamic loop bound -> ' + bad.join( ', ' ) +
			'. Use a #define or a material define, never a uniform.';
		console.error( msg );
		throw new Error( msg );
	}

	return true;

}

/** Surfaces GLSL link/compile failures in the console instead of a black frame. */
export function installShaderCompileGuard( renderer ) {

	if ( ! renderer || ! renderer.debug ) return;

	renderer.debug.checkShaderErrors = true;
	renderer.debug.onShaderError = ( gl, program, vs, fs ) => {
		console.error( '[EFL/shader] link failed', {
			program: ( gl.getProgramInfoLog( program ) || '' ).trim(),
			vertex: ( gl.getShaderInfoLog( vs ) || '' ).trim(),
			fragment: ( gl.getShaderInfoLog( fs ) || '' ).trim(),
		} );
	};

}

/* ==========================================================================
 * SkySystem
 * ========================================================================== */
export class SkySystem {

	static id = 'sky';
	static deps = [ 'render' ];

	constructor( options = {} ) {

		this.options = options;
		this.ctx = null;
		this.scene = null;
		this.camera = null;
		this.renderer = null;

		this.uniforms = null;
		this.material = null;
		this.mesh = null;
		this.sunLight = null;
		this.noiseTexture = null;

		this.quality = options.quality ?? 'high';
		this.weather = options.weather ?? 'overcast';
		this.elevation = options.elevation ?? 22;
		this.azimuth = options.azimuth ?? 145;
		this.timeScale = options.timeScale ?? 1;

		this._elapsed = 0;
		this._far = 0;

	}

	// Registry.get() throws for unregistered ids, so prefer the non-throwing
	// peek(). 'render' is a declared dep, but the capture harness builds partial
	// engines, and ctx itself carries no renderer.
	_resolveRenderer( ctx ) {

		let render = null;
		try {
			if ( ctx && typeof ctx.peek === 'function' ) render = ctx.peek( 'render' );
			else if ( ctx && typeof ctx.get === 'function' ) render = ctx.get( 'render' );
		} catch ( err ) {
			render = null;
		}

		return render?.renderer ?? ctx?.renderer ?? ctx?.engine?.renderer ?? null;

	}

	_defines() {

		const preset = SKY_QUALITY_PRESETS[ this.quality ] ?? SKY_QUALITY_PRESETS.high;
		const defines = {
			STEPS: preset.STEPS,
			LIGHT_STEPS: preset.LIGHT_STEPS,
			CLOUDS: preset.CLOUDS,
		};

		if ( this.renderer && this.renderer.outputColorSpace !== THREE.SRGBColorSpace ) {
			defines.SRGB_ENCODE = 1;
		}

		return defines;

	}

	// Radius from the live far plane. engine.js builds the gameplay camera with
	// far = 1200; a dome scaled past that used to be clipped away entirely, which
	// is the second black screen this file had.
	_domeRadius() {

		const far = this.camera?.far ?? 1200;
		return Math.max( 50, Math.min( far * 0.5, 8000 ) );

	}

	async init( ctx ) {

		this.ctx = ctx;
		this.scene = ctx?.scene ?? null;
		this.camera = ctx?.camera ?? null;
		this.renderer = this._resolveRenderer( ctx );

		if ( SKY_QUALITY_PRESETS[ ctx?.config?.quality ] ) this.quality = ctx.config.quality;
		if ( SKY_WEATHER_PRESETS[ ctx?.config?.weather ] ) this.weather = ctx.config.weather;

		// Installed before the material exists, so our own link failures are the
		// first thing it catches.
		installShaderCompileGuard( this.renderer );

		// Built here, not in the constructor: every subsystem is constructed
		// synchronously inside engine.add(), and a 9-octave FBM on the main thread
		// there is a visible boot hitch.
		this.noiseTexture = createCloudNoiseTexture(
			this.options.noiseSize ?? ( this.quality === 'low' ? 128 : 256 )
		);

		const w = SKY_WEATHER_PRESETS[ this.weather ] ?? SKY_WEATHER_PRESETS.overcast;

		this.uniforms = {
			uSunDirection: { value: new THREE.Vector3( 0.3, 0.4, 0.85 ).normalize() },
			// 1/Mm units: 5.8 / 13.5 / 33.1 at rayleigh = 1.0. The shader scales to 1/m.
			uRayleighCoeff: { value: new THREE.Vector3( 5.8, 13.5, 33.1 ).multiplyScalar( w.rayleigh ) },
			uGroundAlbedo: { value: new THREE.Color( 0x2b2a26 ) },
			uMieCoeff: { value: w.mie * 1e3 },
			uMieG: { value: w.mieG },
			uTurbidity: { value: w.turbidity },
			uSunIntensity: { value: 20 },
			uExposure: { value: w.exposure },
			uTime: { value: 0 },
			uCameraHeight: { value: 2 },
			uCloudCoverage: { value: w.coverage },
			uCloudDensity: { value: w.density },
			uCloudAltitude: { value: 1400 },
			uCloudSpeed: { value: 1 },
			uCloudNoiseSize: { value: 12 },
			uCloudNoise: { value: this.noiseTexture },
		};

		// [X3595] Fail loudly here rather than stalling the render thread later.
		assertStaticLoopBounds( SKY_FRAGMENT_SHADER, 'src/sky/shaders.js#fragment' );

		this.material = new THREE.ShaderMaterial( {
			name: 'EFL_AtmosphereShader',
			uniforms: this.uniforms,
			vertexShader: SKY_VERTEX_SHADER,
			fragmentShader: SKY_FRAGMENT_SHADER,
			defines: this._defines(),
			glslVersion: THREE.GLSL3,
			side: THREE.BackSide,
			depthWrite: false,
			depthTest: false,
			toneMapped: false,
			transparent: false,
			fog: false,
			blending: THREE.NoBlending,
		} );

		this.mesh = new THREE.Mesh( new THREE.SphereGeometry( 1, 64, 40 ), this.material );
		this.mesh.name = 'EFL_SkyDome';
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = -1000;
		// Render contract: the sky must not pollute the depth/normal prepass or the
		// shadow cascades.
		this.mesh.userData.owNoPrepass = true;
		this.mesh.userData.owNoShadow = true;

		this._far = this.camera?.far ?? 1200;
		this.mesh.scale.setScalar( this._domeRadius() );
		if ( this.camera ) this.mesh.position.copy( this.camera.position );

		this.sunLight = new THREE.DirectionalLight( 0xfff2e0, 2.2 );
		this.sunLight.name = 'EFL_SunLight';
		this.sunLight.castShadow = true;

		if ( this.scene ) {
			this.scene.add( this.mesh );
			this.scene.add( this.sunLight );
		}

		this.setSunAngles( this.elevation, this.azimuth );

	}

	update( dt, ctx ) {

		this._elapsed += ( dt || 0 ) * this.timeScale;
		if ( ! this.uniforms ) return;
		this.uniforms.uTime.value = this._elapsed;

		const camera = this.camera ?? ctx?.camera ?? null;
		if ( ! camera || ! this.mesh ) return;

		// The dome rides the camera, so the horizon never slides.
		this.uniforms.uCameraHeight.value = Math.max( 1, camera.position.y );
		this.mesh.position.copy( camera.position );

		if ( camera.far !== this._far ) {
			this._far = camera.far;
			this.mesh.scale.setScalar( this._domeRadius() );
		}

	}

	/** Step counts are #defines, so this recompiles rather than branching. */
	setQuality( name ) {

		if ( ! SKY_QUALITY_PRESETS[ name ] || name === this.quality ) return;
		this.quality = name;
		if ( ! this.material ) return;
		this.material.defines = this._defines();
		this.material.needsUpdate = true;

	}

	setWeather( name ) {

		const w = SKY_WEATHER_PRESETS[ name ];
		if ( ! w ) return;
		this.weather = name;
		if ( ! this.uniforms ) return;

		const u = this.uniforms;
		u.uRayleighCoeff.value.set( 5.8, 13.5, 33.1 ).multiplyScalar( w.rayleigh );
		u.uMieCoeff.value = w.mie * 1e3;
		u.uMieG.value = w.mieG;
		u.uTurbidity.value = w.turbidity;
		u.uCloudCoverage.value = w.coverage;
		u.uCloudDensity.value = w.density;
		u.uExposure.value = w.exposure;

		// Re-run so the sun light picks up the new air.
		this.setSunAngles( this.elevation, this.azimuth );

	}

	setSunAngles( elevationDeg, azimuthDeg ) {

		this.elevation = elevationDeg;
		this.azimuth = azimuthDeg;

		const phi = THREE.MathUtils.degToRad( 90 - elevationDeg );
		const theta = THREE.MathUtils.degToRad( azimuthDeg );
		const dir = new THREE.Vector3().setFromSphericalCoords( 1, phi, theta );

		if ( this.uniforms ) this.uniforms.uSunDirection.value.copy( dir );

		if ( this.sunLight ) {
			this.sunLight.position.copy( dir ).multiplyScalar( 2000 );
			this.sunLight.intensity = Math.max(
				0.05,
				Math.sin( THREE.MathUtils.degToRad( Math.max( elevationDeg, 0 ) ) ) * 2.6
			);
			this._applySunColour( dir.y );
		}

	}

	// Sun colour from the same Chapman airmass and the same coefficients the
	// shader uses, so the DirectionalLight can never disagree with the sky it
	// hangs in. Hue only — normalised, so intensity stays where setSunAngles put
	// it.
	_applySunColour( mu ) {

		const u = this.uniforms;
		if ( ! u || ! this.sunLight ) return;

		const R = 6371000;
		const column = ( H ) => {
			const c = Math.sqrt( 0.5 * Math.PI * ( R / H ) );
			return ( c / ( c * Math.max( mu, 0 ) + 1 ) ) * H;
		};
		const amR = column( 8000 );
		const amM = column( 1200 );

		const br = u.uRayleighCoeff.value;
		const bm = ( u.uMieCoeff.value * 1e-6 * ( 0.55 + 0.075 * u.uTurbidity.value ) ) / 0.9;
		const r = Math.exp( - ( br.x * 1e-6 * amR + bm * amM ) );
		const g = Math.exp( - ( br.y * 1e-6 * amR + bm * amM ) );
		const b = Math.exp( - ( br.z * 1e-6 * amR + bm * amM ) );
		const peak = Math.max( r, g, b, 1e-6 );

		this.sunLight.color.setRGB( r / peak, g / peak, b / peak, THREE.LinearSRGBColorSpace );

	}

	dispose() {

		if ( this.mesh ) {
			this.mesh.parent?.remove( this.mesh );
			this.mesh.geometry?.dispose();
		}
		if ( this.sunLight ) this.sunLight.parent?.remove( this.sunLight );

		this.material?.dispose();
		this.noiseTexture?.dispose();

		this.mesh = null;
		this.material = null;
		this.sunLight = null;
		this.noiseTexture = null;
		this.uniforms = null;

	}

}

export default SkySystem;
