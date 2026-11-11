const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const editor = $("editor");
const uploadPanel = $("uploadPanel");
const photoCanvas = $("photoCanvas");
const maskCanvas = $("maskCanvas");
const photoCtx = photoCanvas.getContext("2d");
const maskCtx = maskCanvas.getContext("2d");
const stage = $("stage");
let originalFile = null, originalImage = null, tool = "remove", drawing = false;
let removeMask = null, protectMask = null, resultBlob = null, outputMode = "original";
let lastFormData = null;

function setStatus(text, busy=false){ $("status").textContent=text; $("processBtn").disabled=busy; $("processBtn").textContent=busy?"در حال پردازش…":"پردازش و دریافت خروجی"; }
function setTool(name){tool=name;document.querySelectorAll(".tool").forEach(b=>b.classList.toggle("active",b.dataset.tool===name));}
document.querySelectorAll(".tool").forEach(b=>b.addEventListener("click",()=>setTool(b.dataset.tool)));
$("brushSize").addEventListener("input",e=>$("brushValue").textContent=e.target.value);
$("radius").addEventListener("input",e=>$("radiusValue").textContent=e.target.value);

fileInput.addEventListener("change", async e=>{
  const file=e.target.files[0]; if(!file)return;
  if(file.size>10*1024*1024){alert("حجم فایل باید حداکثر ۱۰ مگابایت باشد.");return;}
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){alert("فرمت فایل پشتیبانی نمی‌شود.");return;}
  const url=URL.createObjectURL(file); const img=new Image();
  img.onload=()=>{
    if(img.naturalWidth*img.naturalHeight>16000000){URL.revokeObjectURL(url);alert("ابعاد عکس بیش از ۱۶ مگاپیکسل است.");return;}
    originalFile=file; originalImage=img;
    photoCanvas.width=maskCanvas.width=img.naturalWidth;
    photoCanvas.height=maskCanvas.height=img.naturalHeight;
    photoCtx.clearRect(0,0,photoCanvas.width,photoCanvas.height);photoCtx.drawImage(img,0,0);
    removeMask=new Uint8Array(img.naturalWidth*img.naturalHeight);
    protectMask=new Uint8Array(img.naturalWidth*img.naturalHeight);
    maskCtx.clearRect(0,0,maskCanvas.width,maskCanvas.height);
    stage.style.aspectRatio=`${img.naturalWidth}/${img.naturalHeight}`;
    uploadPanel.classList.add("hidden");editor.classList.remove("hidden");$("resultPanel").classList.add("hidden");
    setStatus("عکس آماده است. ناحیه انعکاس را انتخاب کنید.");URL.revokeObjectURL(url);
  };
  img.onerror=()=>{URL.revokeObjectURL(url);alert("خواندن عکس ناموفق بود.");};img.src=url;
});

function pointerToImage(e){
  const rect=maskCanvas.getBoundingClientRect();
  return {x:Math.max(0,Math.min(maskCanvas.width-1,Math.round((e.clientX-rect.left)*maskCanvas.width/rect.width))),
          y:Math.max(0,Math.min(maskCanvas.height-1,Math.round((e.clientY-rect.top)*maskCanvas.height/rect.height)))};
}
function paint(e){
  const p=pointerToImage(e), radius=Number($("brushSize").value)/2;
  const target=tool==="protect"?protectMask:removeMask;
  const other=tool==="protect"?removeMask:protectMask;
  const r=Math.max(1,Math.round(radius)), x0=Math.max(0,p.x-r),x1=Math.min(maskCanvas.width-1,p.x+r),y0=Math.max(0,p.y-r),y1=Math.min(maskCanvas.height-1,p.y+r);
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){if((x-p.x)**2+(y-p.y)**2<=r*r){const i=y*maskCanvas.width+x;if(tool==="erase"){removeMask[i]=0;protectMask[i]=0;}else{target[i]=255;other[i]=0;}}}
  redrawMask();
}
function redrawMask(){
  const w=maskCanvas.width,h=maskCanvas.height;
  const imageData=maskCtx.createImageData(w,h),d=imageData.data;
  for(let i=0;i<removeMask.length;i++){const j=i*4;if(removeMask[i]){d[j]=238;d[j+1]=65;d[j+2]=65;d[j+3]=115;}else if(protectMask[i]){d[j]=40;d[j+1]=155;d[j+2]=235;d[j+3]=125;}}
  maskCtx.putImageData(imageData,0,0);
}
maskCanvas.addEventListener("pointerdown",e=>{if(!originalImage)return;drawing=true;maskCanvas.setPointerCapture(e.pointerId);paint(e);});
maskCanvas.addEventListener("pointermove",e=>{if(drawing)paint(e);});
maskCanvas.addEventListener("pointerup",()=>drawing=false);
maskCanvas.addEventListener("pointercancel",()=>drawing=false);
$("clearMask").addEventListener("click",()=>{removeMask.fill(0);protectMask.fill(0);redrawMask();setStatus("ماسک‌ها پاک شدند.");});

function canvasToBlob(canvas,type="image/png",quality){return new Promise(resolve=>canvas.toBlob(resolve,type,quality));}
async function processImage(){
  if(!originalFile)return;
  if(!removeMask.some(v=>v>0)){setStatus("ابتدا با قلم قرمز انعکاس مزاحم را انتخاب کنید.");return;}
  setStatus("در حال ارسال و پردازش…",true);
  const removeCanvas=document.createElement("canvas");removeCanvas.width=photoCanvas.width;removeCanvas.height=photoCanvas.height;
  const rctx=removeCanvas.getContext("2d"),rdata=rctx.createImageData(removeCanvas.width,removeCanvas.height);
  for(let i=0;i<removeMask.length;i++){const j=i*4;rdata.data[j]=rdata.data[j+1]=rdata.data[j+2]=removeMask[i];rdata.data[j+3]=255;}rctx.putImageData(rdata,0,0);
  const protectCanvas=document.createElement("canvas");protectCanvas.width=photoCanvas.width;protectCanvas.height=photoCanvas.height;
  const pctx=protectCanvas.getContext("2d"),pdata=pctx.createImageData(protectCanvas.width,protectCanvas.height);
  for(let i=0;i<protectMask.length;i++){const j=i*4;pdata.data[j]=pdata.data[j+1]=pdata.data[j+2]=protectMask[i];pdata.data[j+3]=255;}pctx.putImageData(pdata,0,0);
  const [removeBlob,protectBlob]=await Promise.all([canvasToBlob(removeCanvas),canvasToBlob(protectCanvas)]);
  const fd=new FormData();fd.append("image",originalFile,originalFile.name);fd.append("remove_mask",removeBlob,"remove.png");fd.append("protect_mask",protectBlob,"protect.png");
  fd.append("method",$("method").value);fd.append("radius",$("radius").value);fd.append("auto_protect",$("autoProtect").checked);
  outputMode=$("outputMode").value;
  fd.append("output_mode",outputMode);fd.append("quality","92");lastFormData=fd;
  try{
    const res=await fetch("/api/process",{method:"POST",body:fd});
    if(!res.ok){let msg="پردازش ناموفق بود.";try{const j=await res.json();msg=j.detail||msg;}catch{}throw new Error(msg);}
    resultBlob=await res.blob();
    if(outputMode==="both"){
      const a=document.createElement("a");a.href=URL.createObjectURL(resultBlob);a.download="citysofal-outputs.zip";a.click();URL.revokeObjectURL(a.href);
      setStatus("هر دو خروجی با موفقیت آماده و دانلود شدند. برای مقایسه، حالت خروجی اصلی یا وب را انتخاب کنید.");
      $("resultPanel").classList.add("hidden");
    }else{
      const previewUrl=URL.createObjectURL(resultBlob);
      $("beforeImage").src=URL.createObjectURL(originalFile);$("afterImage").src=previewUrl;
      $("beforeClip").style.clipPath="inset(0 50% 0 0)";$("compareLine").style.left="50%";$("compareRange").value=50;
      $("resultPanel").classList.remove("hidden");$("resultPanel").scrollIntoView({behavior:"smooth",block:"start"});
      setStatus("پردازش انجام شد. عکس را با اسلایدر مقایسه کنید.");
    }
  }catch(err){setStatus(err.message||"خطا در ارتباط با سرور.");}
  finally{$("processBtn").disabled=false;$("processBtn").textContent="پردازش و دریافت خروجی";}
}
$("processBtn").addEventListener("click",processImage);
$("compareRange").addEventListener("input",e=>{const v=e.target.value;$("beforeClip").style.clipPath=`inset(0 ${100-v}% 0 0)`;$("compareLine").style.left=v+"%";});
$("downloadAgain").addEventListener("click",()=>{if(!resultBlob)return;const a=document.createElement("a");a.href=URL.createObjectURL(resultBlob);a.download=outputMode==="web"?"citysofal-retouched-web.webp":"citysofal-retouched-original.png";a.click();URL.revokeObjectURL(a.href);});
$("newPhoto").addEventListener("click",()=>{editor.classList.add("hidden");uploadPanel.classList.remove("hidden");fileInput.value="";originalFile=null;originalImage=null;});
