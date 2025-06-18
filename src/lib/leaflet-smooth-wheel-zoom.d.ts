import 'leaflet';

declare module 'leaflet' {
    interface MapOptions {
        smoothWheelZoom?: boolean | 'center';
        smoothSensitivity?: number;
    }

    namespace Map {
        interface SmoothWheelZoom extends Handler {
            _isWheeling: boolean;
            _wheelMousePosition: Point;
            _centerPoint: Point;
            _startLatLng: LatLng;
            _wheelStartLatLng: LatLng;
            _startZoom: number;
            _moved: boolean;
            _zooming: boolean;
            _goalZoom: number;
            _prevCenter: LatLng;
            _prevZoom: number;
            _zoomAnimationId: number;
            _timeoutId: number;
        }
    }
} 