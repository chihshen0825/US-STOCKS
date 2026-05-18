using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Navigation;
using System.Windows.Shapes;
using TechAnalysisAPI;

namespace TechAnalysisAPI_Sample
{
    /// <summary>
    /// MainWindow.xaml 的互動邏輯
    /// </summary>
    public partial class MainWindow : Window
    {

        /// <summary>分K選單</summary>
        Dictionary<int, eNK_Kind> fNKKindList = new Dictionary<int, eNK_Kind>();

        /// <summary>指標選單(Key=指標(eTA_Type), Value=指標的參數(TTAParamList))</summary>
        mapTAParam fTAMap = new mapTAParam();

        public MainWindow()
        {
            InitializeComponent();

            Dispatcher.BeginInvoke(new Action(() =>
            {
                #region 分K選單
                fNKKindList.Add((int)eNK_Kind.K_1m, eNK_Kind.K_1m);
                fNKKindList.Add((int)eNK_Kind.K_3m, eNK_Kind.K_3m);
                fNKKindList.Add((int)eNK_Kind.K_5m, eNK_Kind.K_5m);
                cbNK.ItemsSource = fNKKindList.Keys;
                cbNK.SelectedItem = fNKKindList.Keys.Last();
                #endregion

                #region 指標選單
                cbTAType.ItemsSource = fTAMap.Keys;
                cbTAType.SelectedItem = fTAMap.Keys.First();
                #endregion

                edtDateStart.Text = DateTime.Now.ToString("yyyyMMdd");
                edtBS_Date.Text = DateTime.Now.ToString("yyyyMMdd");
                //
                TechAnalysisAPI_Init();//技術指標API init
            }));
        }

        private void btnDoLogin_Click(object sender, RoutedEventArgs e)//執行登入
        {
            try
            {
                var sID = edtID.Text.Trim();
                var sPwd = edtPwd.Password.Trim();
                if (string.IsNullOrEmpty(sID) || string.IsNullOrWhiteSpace(sID))
                {
                    MessageBox.Show("請輸入身份證!");
                    return;
                }
                if (string.IsNullOrEmpty(sPwd) || string.IsNullOrWhiteSpace(sPwd))
                {
                    MessageBox.Show("請輸入密碼!");
                    return;
                }

                if (!fTechAnalysisAPI.Login(sID, sPwd))
                    MessageBox.Show("登入有誤!");
            }
            catch { ;}
        }


        #region 技術指標API
        TTechAnalysisAPI fTechAnalysisAPI = null;
        void TechAnalysisAPI_Init()
        {
            fTechAnalysisAPI = new TTechAnalysisAPI();
            fTechAnalysisAPI.OnTAConnStuEvent += TechAnalysisAPI_OnTAConnStuEvent;//連線狀態
        }

        void TechAnalysisAPI_OnTAConnStuEvent(object sender, bool aIsOK)//連線狀態
        {
            Dispatcher.BeginInvoke(new Action(delegate
            {
                tbcMain.IsEnabled = aIsOK;
                if (aIsOK)
                    tbx_ErrorMsg.Text = "連線成功!";
                else
                    tbx_ErrorMsg.Text = "連線失敗!";
            }));
        }
        //
        private void btnSubTA_Click(object sender, RoutedEventArgs e) //訂閱指標
        {
            try
            {
                var tmpSubTA = new TSubTARec();

                //商品
                tmpSubTA.ProdID = edtSymbol.Text;
                if (string.IsNullOrEmpty(tmpSubTA.ProdID) || string.IsNullOrWhiteSpace(tmpSubTA.ProdID))
                    return;

                //分K
                if (cbNK.SelectedItem == null)
                    return;
                var iNK = (int)cbNK.SelectedItem;
                tmpSubTA.NK = fNKKindList[iNK];

                //指標
                if (cbTAType.SelectedItem == null)
                    return;
                tmpSubTA.TA_Type = (eTA_Type)cbTAType.SelectedItem;

                //參數                
                tmpSubTA.ParamObj = fTAMap[tmpSubTA.TA_Type].GetParamClass();

                //callback
                tmpSubTA.PROC_CallBack_Update = TACallBack_OnUpdate;
                tmpSubTA.PROC_CallBack_RcvDone = TACallBack_OnRcvDone;

                //K棒回補起始日期
                if (cbDate.SelectedIndex == 0) //當日
                {
                    tmpSubTA.DateBegin = "";
                }
                else //指定起始日期
                {
                    var sDate = edtDateStart.Text;
                    if (sDate == DateTime.Now.ToString("yyyyMMdd"))
                    {
                        tmpSubTA.DateBegin = "";
                    }
                    else
                    {

                        tmpSubTA.DateBegin = sDate;
                    }
                }
                //執行訂閱
                string sErrMsg = string.Empty;
                if (!fTechAnalysisAPI.SubTA(tmpSubTA, out sErrMsg))
                    tbx_ErrorMsg.Text = sErrMsg;
            }
            catch (Exception ex)
            { }
        }
        private void btn_UnSubTA_Click(object sender, RoutedEventArgs e) //取消訂閱指標
        {
            try
            {
                var tmpUnSubTA = new TUnSubTARec();

                //商品
                tmpUnSubTA.ProdID = edtSymbol.Text;
                if (string.IsNullOrEmpty(tmpUnSubTA.ProdID) || string.IsNullOrWhiteSpace(tmpUnSubTA.ProdID))
                    return;

                //分K
                if (cbNK.SelectedItem == null)
                    return;
                var iNK = (int)cbNK.SelectedItem;
                tmpUnSubTA.NK = fNKKindList[iNK];

                //指標
                if (cbTAType.SelectedItem == null)
                    return;
                tmpUnSubTA.TA_Type = (eTA_Type)cbTAType.SelectedItem;

                //參數                
                tmpUnSubTA.ParamObj = fTAMap[tmpUnSubTA.TA_Type].GetParamClass();
                
                //執行取消訂閱
                string sErrMsg = string.Empty;
                if (!fTechAnalysisAPI.UnSubTA(tmpUnSubTA, out sErrMsg))
                    tbx_ErrorMsg.Text = sErrMsg;
            }
            catch (Exception ex)
            { }
        }
        private void cbTAType_SelectionChanged(object sender, SelectionChangedEventArgs e)//切換指標時, 顯示該指標的參數
        {
            //取出指標
            if (cbTAType.SelectedItem == null)
                return;
            var eTA = (eTA_Type)cbTAType.SelectedItem;

            #region 取出該指標的參數s
            if (!fTAMap.ContainsKey(eTA))
                return;
            lbTAParamList.ItemsSource = fTAMap[eTA];

            #endregion
        }
        //
        void TACallBack_OnRcvDone(object sender, object aResult)//指標回補
        {
            if (aResult != null)
            {
                var tmpTA_BAS = sender as TA_Base;
                switch (tmpTA_BAS.SubTARec.TA_Type)
                {
                    #region SMA
                    case eTA_Type.SMA:
                        {
                            var ls = aResult as List<TRes_SMA>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion
                    #region EMA
                    case eTA_Type.EMA:
                        {
                            var ls = aResult as List<TRes_EMA>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region WMA
                    case eTA_Type.WMA:
                        {
                            var ls = aResult as List<TRes_WMA>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region SAR
                    case eTA_Type.SAR:
                        {
                            var ls = aResult as List<TRes_SAR>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region RSI
                    case eTA_Type.RSI:
                        {
                            var ls = aResult as List<TRes_RSI>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region MACD
                    case eTA_Type.MACD:
                        {
                            var ls = aResult as List<TRes_DIF>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region KD
                    case eTA_Type.KD:
                        {
                            var ls = aResult as List<TRes_KD>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region CDP
                    case eTA_Type.CDP:
                        {
                            var ls = aResult as List<TRes_CDP>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region 布林通道
                    case eTA_Type.BBands:
                        {
                            var ls = aResult as List<TRes_BBands>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region 乖離率
                    case eTA_Type.BIAS:
                        {
                            var ls = aResult as List<TRes_BIAS>;
                            if (ls.Count == 0)
                                return;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendLine("==============================================");
                            sb.AppendLine(tmpTA_BAS.SubTARec.GetDplyStr());
                            foreach (var tmpRes in ls)
                            {
                                sb.AppendFormat(tmpRes.GetDplyStr());
                                sb.AppendLine();
                            }

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion
                }
               
            }
        }
        void TACallBack_OnUpdate(object sender, object aResultPre, object aResultLast)//指標即時最新兩根K的值
        {
            var tmpTA_BAS = sender as TA_Base;

            if (aResultPre != null)//前一根
            {
                #region
                switch (tmpTA_BAS.SubTARec.TA_Type)
                {
                    #region SMA
                    case eTA_Type.SMA:
                        {
                            var tmpRes = aResultPre as TRes_SMA;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region EMA
                    case eTA_Type.EMA:
                        {
                            var tmpRes = aResultPre as TRes_EMA;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());
                            
                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region WMA
                    case eTA_Type.WMA:
                        {
                            var tmpRes = aResultPre as TRes_WMA;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region SAR
                    case eTA_Type.SAR:
                        {
                            var tmpRes = aResultPre as TRes_SAR;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region RSI
                    case eTA_Type.RSI:
                        {
                            var tmpRes = aResultPre as TRes_RSI;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region MACD
                    case eTA_Type.MACD:
                        {
                            var tmpRes = aResultPre as TRes_DIF;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region KD
                    case eTA_Type.KD:
                        {
                            var tmpRes = aResultPre as TRes_KD;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region CDP
                    case eTA_Type.CDP:
                        {
                            var tmpRes = aResultPre as TRes_CDP;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region 布林通道
                    case eTA_Type.BBands:
                        {
                            var tmpRes = aResultPre as TRes_BBands;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region 乖離率
                    case eTA_Type.BIAS:
                        {
                            var tmpRes = aResultPre as TRes_BIAS;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==前K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion
                }
                #endregion
            }
            if (aResultLast != null)//最新一根
            {
                #region
                switch (tmpTA_BAS.SubTARec.TA_Type)
                {
                    #region SMA
                    case eTA_Type.SMA:
                        {
                            var tmpRes = aResultLast as TRes_SMA;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region EMA
                    case eTA_Type.EMA:
                        {
                            var tmpRes = aResultLast as TRes_EMA;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region WMA
                    case eTA_Type.WMA:
                        {
                            var tmpRes = aResultLast as TRes_WMA;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region SAR
                    case eTA_Type.SAR:
                        {
                            var tmpRes = aResultLast as TRes_SAR;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region RSI
                    case eTA_Type.RSI:
                        {
                            var tmpRes = aResultLast as TRes_RSI;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region MACD
                    case eTA_Type.MACD:
                        {
                            var tmpRes = aResultLast as TRes_DIF;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region KD
                    case eTA_Type.KD:
                        {
                            var tmpRes = aResultLast as TRes_KD;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region CDP
                    case eTA_Type.CDP:
                        {
                            var tmpRes = aResultLast as TRes_CDP;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.AppendLine(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region 布林通道
                    case eTA_Type.BBands:
                        {
                            var tmpRes = aResultPre as TRes_BBands;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion

                    #region 乖離率
                    case eTA_Type.BIAS:
                        {
                            var tmpRes = aResultPre as TRes_BIAS;
                            StringBuilder sb = new StringBuilder();
                            sb.AppendFormat("==最新K:{0},", tmpTA_BAS.SubTARec.GetDplyStr());
                            sb.Append(tmpRes.GetDplyStr());

                            PrintText(sb.ToString());
                        }
                        break;
                    #endregion
                }
                #endregion
            }
        }
        #endregion

        #region
        private void btnSubBS_Click(object sender, RoutedEventArgs e) //載入成交歷史
        {
            try
            {
                var tmpSub = new TSubBSRec();

                //商品
                tmpSub.ProdID = edtBS_Symbol.Text;
                if (string.IsNullOrEmpty(tmpSub.ProdID) || string.IsNullOrWhiteSpace(tmpSub.ProdID))
                    return;                

                //回補日期
                var sDate = edtBS_Date.Text;
                if (sDate == DateTime.Now.ToString("yyyyMMdd"))
                {
                    MessageBox.Show("不可回補當日!");
                }
                else
                {
                    tmpSub.Date = sDate;
                }

                //執行
                MLApi_AdvQuote.TObjBSRecLSS lsBS = null;
                string sErrMsg = string.Empty;
                if (!fTechAnalysisAPI.GetHisBS_Stock(tmpSub, out lsBS, out sErrMsg))
                {
                    tbx_ErrorMsg.Text = sErrMsg;
                    return;
                }

                //顯示
                StringBuilder sb = new StringBuilder();
                foreach (var tmpBS in lsBS)
                {
                    sb.AppendFormat("時間:{0} ", tmpBS.Match_Time);
                    sb.AppendFormat("成交價:{0} ", tmpBS.Match_Price);
                    sb.AppendFormat("單量:{0} ", tmpBS.Match_Quantity);                    
                    sb.AppendFormat("總量:{0} ", tmpBS.Match_Volume);
                    sb.AppendLine();
                }
                tbx_BS_Msg.Text = sb.ToString();

            }
            catch (Exception ex)
            { }
        }
        #endregion



        void PrintText(string aMsg) 
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                tbx_Msg.AppendText(string.Format(" {0} \n", aMsg));
            }));
        }
    }
}
