'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

// Dynamically import MapWrapper with no SSR
const MapWrapper = dynamic(() => import('../components/MapWrapper'), {
  ssr: false,
});

export default function Home() {
  const searchParams = useSearchParams();
  const routeData = searchParams.get('route');
  
  let initialWaypoints: [number, number][] = [];
  if (routeData) {
    try {
      // Decode and parse the route data
      const decoded = decodeURIComponent(routeData);
      initialWaypoints = JSON.parse(decoded);
    } catch (error) {
      console.error('Failed to parse route data:', error);
    }
  }

  return (
    <main>
      <MapWrapper initialWaypoints={initialWaypoints} />
    </main>
  );
}
