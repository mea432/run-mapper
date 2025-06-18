'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

// Dynamically import MapWrapper with no SSR
const MapWrapper = dynamic(() => import('@/components/MapWrapper'), { ssr: false });

function HomeContent() {
  const searchParams = useSearchParams();
  const routeParam = searchParams.get('route');
  
  let waypoints: [number, number][] = [];
  if (routeParam) {
    try {
      // Decode and parse the route data
      waypoints = JSON.parse(decodeURIComponent(routeParam));
    } catch (e) {
      console.error('Error parsing route:', e);
    }
  }

  return <MapWrapper initialWaypoints={waypoints} />;
}

export default function HomePage() {
  return (
    <Suspense fallback={<div>Loading map...</div>}>
      <HomeContent />
    </Suspense>
  );
}

