import { Link } from 'react-router-dom';

import BrandMark from '../../components/ui/BrandMark';

export default function MarketingFooter() {
  return (
    <footer className="border-t border-slate-100 bg-white">
      <div className="mx-auto max-w-6xl px-5 py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <BrandMark size={28} />
              <span className="text-base font-extrabold text-brand-700">SanjeevniOS</span>
            </div>
            <p className="mt-2 text-sm text-slate-500">Your Health, Our Priority.</p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Product</p>
              <div className="mt-2 flex flex-col gap-2 text-sm">
                <Link to="/for-patients" className="text-slate-600 hover:text-brand-600">
                  For Patients
                </Link>
                <Link to="/for-clinics" className="text-slate-600 hover:text-brand-600">
                  For Clinics
                </Link>
              </div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Company</p>
              <div className="mt-2 flex flex-col gap-2 text-sm">
                <Link to="/about" className="text-slate-600 hover:text-brand-600">
                  About
                </Link>
                <Link to="/contact" className="text-slate-600 hover:text-brand-600">
                  Contact
                </Link>
              </div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Account</p>
              <div className="mt-2 flex flex-col gap-2 text-sm">
                <Link to="/login" className="text-slate-600 hover:text-brand-600">
                  Patient Login
                </Link>
                <Link to="/clinic/login" className="text-slate-600 hover:text-brand-600">
                  Clinic Login
                </Link>
                <Link to="/clinic/login?mode=register" className="text-slate-600 hover:text-brand-600">
                  Register your clinic
                </Link>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-8 border-t border-slate-100 pt-6 text-xs text-slate-400">
          © {new Date().getFullYear()} SanjeevniOS. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
