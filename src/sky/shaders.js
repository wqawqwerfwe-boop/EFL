/* ==========================================================================
 * Escape-From-Larpov · src/sky/shaders.js
 *
 * The atmosphere and cloud GLSL for SkySystem. These two constants were the
 * ones missing from src/sky/index.js, which is what threw
 *   ReferenceError: SKY_FRAGMENT_SHADER is not defined at SkySystem.init
 * on boot. index.js re-exports both, so existing import paths keep working.
 *
 * GLSL ES 3.00 (glslVersion: THREE.GLSL3), matching the rest of src/sky/.
 *
 * [X3595] LOOP AND DERIVATIVE POLICY — do not regress this:
 *   1. Every `for` loop is bounded by a compile-time constant that arrives as a
 *      #define through THREE.ShaderMaterial.defines (STEPS, LIGHT_STEPS). Never
 *      a uniform. The bounds are part of the shader permutation key, so quality
 *      changes recompile instead of branching per pixel.
 *   2. No loop contains a `break`, so the iteration count cannot vary.
 *   3. The shader contains no implicit-derivative instruction whatsoever:
 *      texture reads use textureLod() with an analytically derived level, and
 *      edge antialiasing uses fixed angular widths instead of fwidth().
 * Together (1)-(3) make "gradient instruction used in a loop with varying
 * iteration" structurally impossible rather than merely unlikely — and they are
 * why the cloud path may branch freely without paying a stall for it.
 * ========================================================================== */

export const SKY_VERTEX_SHADER = /* glsl */ `
out vec3 vRayDir;

void main() {

	// The dome is re-centred on the camera every frame, so its object-space
	// position is the view direction once the model rotation and scale apply.
	vRayDir = mat3( modelMatrix ) * position;

	vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

	// Pin the dome to the far plane. Without this, a dome larger than camera.far
	// is clipped away in clip space and the frame comes back black: depthTest
	// false cannot save it, because clipping happens before the depth test runs.
	// With it, the dome radius stops mattering.
	clip.z = clip.w;
	gl_Position = clip;

}
`;

export const SKY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

// Compile-time quality knobs. Real values arrive through ShaderMaterial.defines
// (SkySystem._defines); these fallbacks only keep the source standalone.
// [X3595] These MUST stay #defines: every loop bound below is one of them.
#ifndef STEPS
	#define STEPS 32
#endif
#ifndef LIGHT_STEPS
	#define LIGHT_STEPS 6
#endif
#ifndef CLOUDS
	#define CLOUDS 1
#endif

const float PI = 3.141592653589793;
const float INV_PI = 0.3183098861837907;
const float INV_4PI = 0.07957747154594767;

// Planetary shell, metres.
const float R_GROUND = 6371000.0;
const float R_TOP = 6471000.0;
const float H_RAY = 8000.0;
const float H_MIE = 1200.0;
const float X_RAY = R_GROUND / H_RAY;
const float X_MIE = R_GROUND / H_MIE;

// Angular radius of the sun, and the factor it is drawn oversize by so it
// survives TAA and the sharpen filter. Energy is divided by the area factor, so
// a larger disc is not a brighter sun.
const float SUN_ANGULAR_R = 0.00465;
const float SUN_DRAW_SCALE = 2.4;
const float SUN_SOLID_ANGLE = 6.7935e-5;

// Energy returned by second- and higher-order scattering, which a single
// scattering integral cannot see. Without it the zenith reads too dark and an
// overcast sky goes grey-black instead of luminous.
const float MULTI_SCATTER = 0.55;

uniform vec3 uSunDirection;
uniform vec3 uRayleighCoeff;
uniform vec3 uGroundAlbedo;
uniform float uMieCoeff;
uniform float uMieG;
uniform float uTurbidity;
uniform float uSunIntensity;
uniform float uExposure;
uniform float uTime;
uniform float uCameraHeight;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudAltitude;
uniform float uCloudSpeed;
uniform float uCloudNoiseSize;
uniform sampler2D uCloudNoise;

in vec3 vRayDir;
layout(location = 0) out vec4 fragColor;

// The presets carry the coefficients in the conventional 1/Mm units, so they are
// scaled to 1/m here and nowhere else.
vec3 betaRayleigh() {
	return max( uRayleighCoeff, vec3( 0.0 ) ) * 1.0e-6;
}

float betaMie() {
	return max( uMieCoeff, 0.0 ) * 1.0e-6 * ( 0.55 + 0.075 * max( uTurbidity, 0.0 ) );
}

// Aerosol single-scattering albedo is about 0.9, so extinction sits a little
// above scattering. That difference is what greys out a hazy horizon.
float betaMieExt() {
	return betaMie() / 0.9;
}

// Nearest positive hit of a ray against a sphere centred on the origin.
float raySphere( vec3 ro, vec3 rd, float radius ) {

	float b = dot( ro, rd );
	float c = dot( ro, ro ) - radius * radius;
	float d = b * b - c;
	if ( d < 0.0 ) return -1.0;
	d = sqrt( d );
	float t1 = -b + d;
	if ( t1 < 0.0 ) return -1.0;
	float t0 = -b - d;
	return t0 < 0.0 ? t1 : t0;

}

float phaseRayleigh( float mu ) {
	return 3.0 / ( 16.0 * PI ) * ( 1.0 + mu * mu );
}

float phaseHG( float mu, float g ) {

	float g2 = g * g;
	float d = max( 1.0e-4, 1.0 + g2 - 2.0 * g * mu );
	return INV_4PI * ( 1.0 - g2 ) / ( d * sqrt( d ) );

}

// Chapman function: column density along a ray leaving altitude h (in scale
// heights) at zenith cosine mu, expressed in scale heights. Correct in both
// limits that matter - 1.0 straight up, sqrt( pi * X / 2 ) along the horizon -
// which is what makes a low sun redden properly instead of merely dimming.
//
// Only the upward branch exists, deliberately: the analytic continuation for
// downward rays contains exp( X ), which overflows to Inf for a real planet and
// would poison the frame. Rays that dive into the planet are handled by
// sunVisibility() instead.
float chapman( float X, float h, float mu ) {

	float c = sqrt( 0.5 * PI * ( X + h ) );
	return c / ( c * max( mu, 0.0 ) + 1.0 ) * exp( -h );

}

// Geometric terminator, softened by roughly the atmospheric refraction plus the
// solar radius. Below it, the light ray has crossed the planet.
float sunVisibility( float mu ) {
	return smoothstep( -0.035, 0.020, mu );
}

// Transmittance from an altitude out to space along a light ray.
vec3 lightTransmittance( float altitude, float mu ) {

	float alt = max( altitude, 0.0 );
	vec3 od = betaRayleigh() * ( H_RAY * chapman( X_RAY, alt / H_RAY, mu ) )
		+ vec3( betaMieExt() * ( H_MIE * chapman( X_MIE, alt / H_MIE, mu ) ) );
	return exp( -od ) * sunVisibility( mu );

}

// Sun irradiance reaching a given altitude, in scene light units.
vec3 sunIrradiance( float altitude, vec3 sunDir ) {
	return vec3( max( uSunIntensity, 0.0 ) ) * lightTransmittance( altitude, sunDir.y );
}

// Single scattering along the view ray. The light-ray optical depth comes from
// chapman() analytically rather than from a nested march, which is what keeps
// this to one loop: a nested STEPS x LIGHT_STEPS march is 350+ iterations per
// pixel and is exactly the shape that stalls drivers.
//
// [X3595] One loop, bound by the STEPS #define, no break, no texture read, no
// derivative.
void atmosphere( vec3 ro, vec3 rd, vec3 sunDir, out vec3 radiance, out vec3 viewTransmittance ) {

	radiance = vec3( 0.0 );
	viewTransmittance = vec3( 1.0 );

	float tTop = raySphere( ro, rd, R_TOP );
	float tGround = raySphere( ro, rd, R_GROUND );
	float tMax = tGround > 0.0 ? tGround : tTop;
	if ( tMax <= 0.0 ) return;

	vec3 betaR = betaRayleigh();
	float betaM = betaMie();
	float betaMe = betaMieExt();

	float mu = dot( rd, sunDir );
	float pR = phaseRayleigh( mu );
	float pM = phaseHG( mu, clamp( uMieG, -0.95, 0.95 ) );

	float dt = tMax / float( STEPS );
	float t = 0.5 * dt;
	float odR = 0.0;
	float odM = 0.0;
	vec3 sumR = vec3( 0.0 );
	vec3 sumM = vec3( 0.0 );

	for ( int i = 0; i < STEPS; i ++ ) {

		vec3 p = ro + rd * t;
		float r = max( length( p ), R_GROUND );
		float alt = r - R_GROUND;
		float dR = exp( -alt / H_RAY );
		float dM = exp( -alt / H_MIE );

		odR += dR * dt;
		odM += dM * dt;

		vec3 tView = exp( -( betaR * odR + vec3( betaMe * odM ) ) );
		vec3 tSun = lightTransmittance( alt, dot( p / r, sunDir ) );
		vec3 w = tView * tSun * dt;

		sumR += w * dR;
		sumM += w * dM;
		t += dt;

	}

	viewTransmittance = exp( -( betaR * odR + vec3( betaMe * odM ) ) );

	float sun = max( uSunIntensity, 0.0 );
	radiance = sun * ( betaR * ( pR * sumR ) + vec3( betaM * pM ) * sumM )
		+ sun * ( MULTI_SCATTER * INV_4PI ) * ( betaR * sumR + vec3( betaM ) * sumM );

}

#if CLOUDS

// One read is worth three octaves: createCloudNoiseTexture packs value noise at
// frequencies 4, 8 and 16 into R, G and B.
//
// textureLod, never texture(): an implicit LOD inside a loop is precisely what
// makes a driver emit "gradient instruction used in a loop with varying
// iteration", and it is unnecessary here because the correct filter width is a
// function of the ray elevation, which we know analytically.
float cloudTap( vec2 uv, float lod ) {

	vec3 n = textureLod( uCloudNoise, uv, lod ).rgb;
	return n.r * 0.55 + n.g * 0.30 + n.b * 0.15;

}

// Nine effective octaves from three reads, manually unrolled: cheaper than a
// loop, and immune to the problem loops have.
float cloudFbm( vec2 uv, vec2 drift, float lod ) {

	float f = cloudTap( uv + drift, lod ) * 0.56;
	f += cloudTap( uv * 2.7 + drift * 1.9 + 11.3, lod ) * 0.28;
	f += cloudTap( uv * 7.3 - drift * 2.6 + 5.1, lod + 0.5 ) * 0.16;
	return f;

}

float cloudCover( float f, float coverage ) {

	float thr = 1.0 - clamp( coverage, 0.0, 1.0 );
	return smoothstep( thr, thr + 0.26, f );

}

// Single-read density, for the light march only.
float cloudDensityCheap( vec2 uv, vec2 drift, float lod ) {
	return cloudCover( cloudTap( uv + drift, lod ), uCloudCoverage );
}

// Optical depth toward the light.
// [X3595] Fixed LIGHT_STEPS bound, no break, explicit LOD.
float cloudLightDepth( vec2 uv, vec2 drift, vec2 sunStep, float lod ) {

	float sum = 0.0;
	vec2 p = uv;

	for ( int j = 0; j < LIGHT_STEPS; j ++ ) {

		p += sunStep;
		sum += cloudDensityCheap( p, drift, lod + 1.0 );

	}

	return sum / float( LIGHT_STEPS );

}

// Cumulus deck at uCloudAltitude, intersected as a shell so it curves away to
// the horizon instead of stretching to infinity the way a flat plane does.
vec4 cumulus( vec3 ro, vec3 rd, vec3 sunDir, vec3 sunIrr, vec3 skyCol, float mu ) {

	if ( rd.y <= 0.008 ) return vec4( 0.0 );

	float altitude = max( uCloudAltitude, 50.0 );
	float t = raySphere( ro, rd, R_GROUND + altitude );
	if ( t <= 0.0 ) return vec4( 0.0 );

	vec3 hit = ro + rd * t;
	vec2 uv = hit.xz / ( max( uCloudNoiseSize, 0.5 ) * 1000.0 );
	vec2 drift = vec2( 0.021, 0.013 ) * ( uTime * uCloudSpeed );

	// Filter width follows the ray elevation: grazing rays cover far more ground
	// per pixel, so they read a coarser mip. Analytic, so no derivative needed.
	float lod = clamp( log2( 1.0 / max( rd.y, 0.02 ) ) - 0.5, 0.0, 6.0 );

	float dens = cloudCover( cloudFbm( uv, drift, lod ), uCloudCoverage );
	if ( dens <= 0.002 ) return vec4( 0.0 );

	// Slant path: a deck is thicker the more obliquely you look through it.
	float stretch = clamp( 1.0 / max( rd.y, 0.06 ), 1.0, 4.5 );
	float tau = dens * max( uCloudDensity, 0.0 ) * 0.055 * stretch;
	float alpha = 1.0 - exp( -tau );

	vec2 sunXZ = sunDir.xz;
	float sl = length( sunXZ );
	vec2 toSun = sl > 1.0e-4 ? sunXZ / sl : vec2( 1.0, 0.0 );
	vec2 sunStep = toSun * ( 0.06 / float( LIGHT_STEPS ) )
		* clamp( 1.0 / ( abs( sunDir.y ) + 0.25 ), 0.6, 3.0 );
	float lit = exp( -cloudLightDepth( uv, drift, sunStep, lod ) * max( uCloudDensity, 0.0 ) * 0.05 );

	// Beer-Powder: the dark rim of a sunlit cumulus.
	float powder = 1.0 - exp( -tau * 2.2 );
	// Two-lobe HG: the forward peak plus the silver lining.
	float ph = mix( phaseHG( mu, 0.72 ), phaseHG( mu, -0.28 ), 0.38 );

	vec3 col = sunIrr * ( lit * powder * ph ) + skyCol * mix( 0.95, 0.45, dens );

	// Aerial perspective: a deck twenty kilometres out is seen through twenty
	// kilometres of air, so it loses contrast toward the sky in front of it.
	float bleed = 1.0 - smoothstep( 0.0, 0.30, rd.y );
	col = mix( col, skyCol, bleed * 0.55 );
	alpha *= smoothstep( 0.0, 0.045, rd.y );

	return vec4( col, clamp( alpha, 0.0, 1.0 ) );

}

// Cirrus veil, five and a half times higher and wind-combed into fibres.
vec4 cirrus( vec3 ro, vec3 rd, vec3 sunIrr, vec3 skyCol, float mu ) {

	if ( rd.y <= 0.02 ) return vec4( 0.0 );

	float t = raySphere( ro, rd, R_GROUND + max( uCloudAltitude, 50.0 ) * 5.5 );
	if ( t <= 0.0 ) return vec4( 0.0 );

	vec3 hit = ro + rd * t;
	vec2 uv = hit.xz / ( max( uCloudNoiseSize, 0.5 ) * 4200.0 );
	vec2 drift = vec2( 0.05, 0.017 ) * ( uTime * uCloudSpeed );
	float lod = clamp( log2( 1.0 / max( rd.y, 0.02 ) ) - 1.0, 0.0, 6.0 );

	// Ridged and anisotropically stretched, which is what reads as fibre.
	float fibre = 1.0 - abs( textureLod( uCloudNoise, uv * vec2( 0.35, 1.0 ) + drift, lod ).r * 2.0 - 1.0 );
	float veil = textureLod( uCloudNoise, uv * 0.4 - drift * 0.5, lod + 1.0 ).g;
	float d = smoothstep( 0.52, 0.95, fibre * 0.65 + veil * 0.5 )
		* clamp( uCloudCoverage * 0.85, 0.0, 1.0 );
	if ( d <= 0.002 ) return vec4( 0.0 );

	vec3 col = skyCol * 0.85 + sunIrr * ( 0.05 + 0.22 * phaseHG( mu, 0.62 ) );
	float alpha = clamp( d * 0.55, 0.0, 0.7 ) * smoothstep( 0.02, 0.12, rd.y );

	return vec4( col, alpha );

}

#endif

// Limb-darkened solar disc. Fixed angular edge width instead of fwidth(), so
// the shader stays free of derivative instructions.
vec3 sunDisc( vec3 rd, vec3 sunDir, vec3 viewTransmittance ) {

	float R = SUN_ANGULAR_R * SUN_DRAW_SCALE;
	float theta = acos( clamp( dot( rd, sunDir ), -1.0, 1.0 ) );
	float cover = 1.0 - smoothstep( R * 0.97, R * 1.03, theta );
	if ( cover <= 0.0 ) return vec3( 0.0 );

	float x = clamp( theta / R, 0.0, 1.0 );
	float limb = sqrt( max( 0.0, 1.0 - x * x ) );
	vec3 shade = pow( vec3( limb ), vec3( 0.32, 0.44, 0.58 ) );
	float radiance = max( uSunIntensity, 0.0 )
		/ ( SUN_SOLID_ANGLE * SUN_DRAW_SCALE * SUN_DRAW_SCALE );

	return shade * ( radiance * cover ) * viewTransmittance;

}

// Hue-preserving highlight compressor. The composite owns the real tone curve;
// this only keeps the aureole and the horizon band inside a half-float target
// when the sky is rendered without one. A power curve, not Reinhard: it has no
// ceiling, so a 40:1 overshoot still comes back as a gradient rather than one
// flat cream plateau.
vec3 rolloff( vec3 c ) {

	const float KNEE = 6.0;
	float l = max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1.0e-6 );
	if ( l <= KNEE ) return c;
	return c * ( pow( l / KNEE, 0.42 ) * KNEE / l );

}

vec3 skyRadiance( vec3 rd ) {

	vec3 ro = vec3( 0.0, R_GROUND + max( uCameraHeight, 1.0 ), 0.0 );
	vec3 sunDir = normalize( uSunDirection );
	float mu = dot( rd, sunDir );

	vec3 radiance;
	vec3 viewT;
	atmosphere( ro, rd, sunDir, radiance, viewT );

	// The sky the decks are seen against, so air and cloud can never disagree.
	vec3 skyCol = radiance;

	if ( rd.y < 0.0 ) {

		// First bounce off the ground: what fills the lower hemisphere for the IBL
		// bake and gives upward-facing surfaces their fill light.
		vec3 ground = uGroundAlbedo
			* ( sunIrradiance( 0.0, sunDir ) * ( max( sunDir.y, 0.0 ) * INV_PI ) + skyCol * 0.30 );
		radiance = mix( radiance, ground, smoothstep( 0.0, -0.15, rd.y ) );

	}

	#if CLOUDS

		float deck = max( uCloudAltitude, 50.0 );
		vec4 high = cirrus( ro, rd, sunIrradiance( deck * 5.5, sunDir ), skyCol, mu );
		radiance = mix( radiance, high.rgb, high.a );
		vec4 low = cumulus( ro, rd, sunDir, sunIrradiance( deck, sunDir ), skyCol, mu );
		radiance = mix( radiance, low.rgb, low.a );

	#endif

	radiance = rolloff( radiance );

	// The disc goes in after the roll-off: it is the one thing in the sky that is
	// supposed to clip and bloom.
	radiance += sunDisc( rd, sunDir, viewT );

	return max( radiance, vec3( 0.0 ) );

}

void main() {

	vec3 col = skyRadiance( normalize( vRayDir ) ) * max( uExposure, 0.0 );

	#ifdef SRGB_ENCODE

		vec3 lo = col * 12.92;
		vec3 hi = pow( max( col, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) * 1.055 - 0.055;
		col = mix( lo, hi, step( vec3( 0.0031308 ), col ) );

	#endif

	// Half-float ceiling: an Inf here would poison bloom and TAA downstream.
	fragColor = vec4( min( col, vec3( 60000.0 ) ), 1.0 );

}
`;

export default { SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER };
