// Load the Firebase client SDK only on deployed HTTPS origin after backend config is supplied.
import {initializeApp,getApp,getApps} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,onAuthStateChanged,signOut} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
let auth=null,user=null;
export async function initialize(config,onChange){
  const app=getApps().length?getApp():initializeApp(config);
  auth=getAuth(app);auth.useDeviceLanguage();
  onAuthStateChanged(auth,u=>{user=u;onChange(u);});
  // Mobile redirect result: onAuthStateChanged observes the resulting signed-in session.
  getRedirectResult(auth).catch(()=>{});
}
export async function signIn(){
  if(!auth)throw Error('Firebase ยังไม่พร้อม');
  const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
  try{return await signInWithPopup(auth,provider);}
  catch(e){
    if(['auth/popup-blocked','auth/cancelled-popup-request','auth/operation-not-supported-in-this-environment'].includes(e.code)){
      await signInWithRedirect(auth,provider);return null;
    }
    throw e;
  }
}
export async function idToken(){if(!user)throw Error('กรุณาเข้าสู่ระบบด้วย Google');return user.getIdToken();}
export async function logOut(){if(auth)await signOut(auth);}
export function currentUser(){return user;}
