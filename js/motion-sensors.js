/**
 * MotionSensorManager — Optional Phone Motion Sensors (Gravity Tilt + Shake)
 * + Interactive Virtual Tilt Pad fallback for desktop & non-HTTPS testing.
 */

export class MotionSensorManager {
  constructor() {
    this.enabled = false;
    this.virtualEnabled = false;
    this.tiltEnabled = true;
    this.shakeEnabled = true;

    this.baseBeta = 35;
    this.baseGamma = 0;
    this.needsCalibration = true;

    this.tiltX = 0;
    this.tiltY = 0;
    this.vTiltX = 0;
    this.vTiltY = 0;

    this.impulseX = 0;
    this.impulseY = 0;

    this._lpAx = 0;
    this._lpAy = 0;
    this._lastEventTime = 0;

    this._onOrientation = this._handleOrientation.bind(this);
    this._onMotion = this._handleMotion.bind(this);
    this.onStatusChange = null;
  }

  async toggleHardwareSensors() {
    if (this.enabled) {
      this.disableHardware();
      return { active: false, message: 'Motion sensors turned off' };
    }

    if (!window.isSecureContext) {
      return {
        active: false,
        needsVirtual: true,
        message: 'Phone sensors need localhost or HTTPS — opened Virtual Tilt Pad!',
      };
    }

    if (typeof DeviceMotionEvent === 'undefined' && typeof DeviceOrientationEvent === 'undefined') {
      return {
        active: false,
        needsVirtual: true,
        message: 'No motion sensors found — opened Virtual Tilt Pad!',
      };
    }

    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') {
          return { active: false, message: 'Motion sensor permission was declined.' };
        }
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          return { active: false, message: 'Orientation permission was declined.' };
        }
      }
    } catch {
      return {
        active: false,
        needsVirtual: true,
        message: 'Could not enable phone sensors — opened Virtual Tilt Pad!',
      };
    }

    this.enabled = true;
    this.needsCalibration = true;
    this._lastEventTime = 0;
    window.addEventListener('deviceorientation', this._onOrientation, { passive: true });
    window.addEventListener('devicemotion', this._onMotion, { passive: true });

    setTimeout(() => {
      if (this.enabled && this._lastEventTime === 0 && this.onStatusChange) {
        this.onStatusChange('No motion data received — try Virtual Tilt Pad in Settings!');
      }
    }, 1400);

    return { active: true, message: 'Motion sensors ON! Tilt or shake your phone.' };
  }

  disableHardware() {
    this.enabled = false;
    window.removeEventListener('deviceorientation', this._onOrientation);
    window.removeEventListener('devicemotion', this._onMotion);
    this.tiltX = 0;
    this.tiltY = 0;
  }

  calibrate() {
    this.needsCalibration = true;
  }

  _handleOrientation(e) {
    if (e.gamma == null || e.beta == null) return;
    this._lastEventTime = performance.now();

    if (this.needsCalibration) {
      this.baseGamma = e.gamma;
      this.baseBeta = e.beta;
      this.needsCalibration = false;
    }

    const dGamma = e.gamma - this.baseGamma;
    const dBeta = e.beta - this.baseBeta;
    const tx = Math.max(-1, Math.min(1, dGamma / 42));
    const ty = Math.max(-1, Math.min(1, dBeta / 42));

    this.tiltX += (tx - this.tiltX) * 0.22;
    this.tiltY += (ty - this.tiltY) * 0.22;
  }

  _handleMotion(e) {
    this._lastEventTime = performance.now();
    let ax = 0, ay = 0;
    const acc = e.acceleration;
    const accG = e.accelerationIncludingGravity;

    if (acc && (acc.x != null || acc.y != null)) {
      ax = acc.x || 0;
      ay = -(acc.y || 0);
    } else if (accG && (accG.x != null || accG.y != null)) {
      this._lpAx = this._lpAx * 0.85 + (accG.x || 0) * 0.15;
      this._lpAy = this._lpAy * 0.85 + (accG.y || 0) * 0.15;
      ax = (accG.x || 0) - this._lpAx;
      ay = -((accG.y || 0) - this._lpAy);
    }

    const mag = Math.hypot(ax, ay);
    if (mag > 1.3) {
      this.impulseX += Math.max(-14, Math.min(14, -ax * 0.45));
      this.impulseY += Math.max(-14, Math.min(14, -ay * 0.45));
    }
  }

  setVirtualTilt(x, y) {
    this.vTiltX = Math.max(-1, Math.min(1, x));
    this.vTiltY = Math.max(-1, Math.min(1, y));
  }

  getCombinedForce() {
    const useTilt = this.tiltEnabled;
    const gx = ((this.enabled && useTilt) ? this.tiltX : 0) + (this.virtualEnabled ? this.vTiltX : 0);
    const gy = ((this.enabled && useTilt) ? this.tiltY : 0) + (this.virtualEnabled ? this.vTiltY : 0);
    const ix = this.shakeEnabled ? this.impulseX : 0;
    const iy = this.shakeEnabled ? this.impulseY : 0;
    this.impulseX = 0;
    this.impulseY = 0;
    return {
      gx: Math.max(-1.4, Math.min(1.4, gx)),
      gy: Math.max(-1.4, Math.min(1.4, gy)),
      ax: ix,
      ay: iy,
    };
  }
}
