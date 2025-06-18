import * as L from 'leaflet';

declare module 'leaflet' {
  namespace Routing {
    interface Waypoint {
      latLng: L.LatLng;
    }

    interface LineOptions {
      styles?: Array<{ color?: string; weight?: number; opacity?: number }>;
      extendToWaypoints?: boolean;
      missingRouteTolerance?: number;
    }

    interface IRouter {}

    interface RoutingControlOptions {
      waypoints?: Routing.Waypoint[] | L.LatLng[];
      routeWhileDragging?: boolean;
      show?: boolean;
      addWaypoints?: boolean;
      fitSelectedRoutes?: boolean | 'smart';
      lineOptions?: LineOptions;
      createMarker?: (i: number, wp: Waypoint) => L.Marker;
      language?: string;
      router?: IRouter;
      useZoomParameter?: boolean;
      showAlternatives?: boolean;
      altLineOptions?: LineOptions;
    }

    function control(options?: RoutingControlOptions): any;
    function osrmv1(options?: any): any;
  }
} 