import type { ReactNode } from 'react';

import BottomTabBar, { PATIENT_TABS } from '../ui/BottomTabBar';
import PageTransition from '../PageTransition';
import PlatformFooterNote from '../ui/PlatformFooterNote';
import Sidebar from './Sidebar';

// Patient app frame. Phone: content + bottom tab bar. Laptop and up: a fixed
// sidebar on the left and the content using the rest of the screen.
export default function PatientShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas pb-24 lg:pb-0 lg:pl-64">
      <Sidebar
        tag="Patient"
        items={PATIENT_TABS.map((t) => ({ key: t.to, label: t.label, icon: t.icon, to: t.to, end: t.end }))}
      />
      <main className="mx-auto w-full max-w-7xl lg:px-6 lg:pb-12">
        <PageTransition>{children}</PageTransition>
        <PlatformFooterNote />
      </main>
      <BottomTabBar />
    </div>
  );
}
