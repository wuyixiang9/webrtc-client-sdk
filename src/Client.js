const EnhancedEventEmitter = require('./EnhancedEventEmitter');
const StreamManager = require('./StreamManager');
const SdpTransformer = require('sdp-transform');
const wsClient = require('./WebSocketClient');
const UserInfo = require('./UserInfo');
const PCManager = require('./PCManager')

class Client extends EnhancedEventEmitter
{
    constructor()
    {
        super();
        this._remoteUsers = new Map();//uid, UserInfo

        this._cameraStream = null;
        this._screenStream = null;

        this._closed = true;
        this._connected = true;
        this._sendPCMap = new Map();//peerConnectionId, PCManager object
        this._recvPCMap = new Map();//peerConnectionId, PCManager object

        this._cameraIndex  = 0;
    }

    async OpenCamera()
    {
        if (this._cameraStream)
        {
            throw Error("the camera is opened");
        }

        try
        {
            this._cameraStream = new StreamManager();
            return await this._cameraStream.Open('camera');
        } catch (error) {
            console.log("create stream error:", error);
            throw new Error("create stream error:" + error);
        }
    }

    /*
    return: {"users":[{"uid":"11111"}, {"uid":"22222"}]}
    */
    async Join({serverHost, roomId, userId})
    {
        this._server = serverHost;
        this._roomId = roomId;
        this._uid    = userId;

        console.log("join api server:", serverHost, "roomId:", roomId, "userId:", userId);

        this.ws = new wsClient();

        this.url = 'ws://' + serverHost;
        this.ws.Connect(this.url);

        await new Promise((resolve, reject) => {
            this._wsRegistEvent(resolve, reject);
        });

        var data = {
            'roomId': roomId,
            'uid': userId
        };
        console.log("ws is connected, starting joining server:", this.url, "data:", data);
        var respData = null;
        try {
            respData = await this.ws.request('join', data);
        } catch (error) {
            console.log("join exception error:", error);
            throw error;
        }

        var users = respData['users'];
        for (const user of users)
        {
            var uid = user['uid'];
            var userinfo = new UserInfo({roomId: this._roomId, uid: uid});

            this._remoteUsers.set(uid, userinfo);
        }
        console.log("join response:", JSON.stringify(respData));

        return respData;
    }

    async PublishCamera({videoEnable, audioEnable})
    {
        if (!this._connected)
        {
            throw new Error('websocket is not ready');
        }

        if (!this._cameraStream)
        {
            throw new Error('camera does not init');
        }

        if (!videoEnable && !audioEnable)
        {
            throw new Error('video and audio are not enable');
        }

        if (this._publishCamera)
        {
            throw new Error('the camera has been published');
        }

        var mediaTracks = [];
        if (videoEnable)
        {
            mediaTracks.push(this._cameraStream.GetVideoTrack());
        }
        if (audioEnable)
        {
            mediaTracks.push(this._cameraStream.GetAudioTrack());
        }

        var sendCameraPc = null;
        var offerInfo;
        try {
            sendCameraPc = new PCManager();
            sendCameraPc.CreatePeerConnection('send');
            sendCameraPc.SetType('camera');
            offerInfo = await sendCameraPc.AddSendMediaTrack(mediaTracks);
        } catch (error) {
            throw error;
        }

        var data = {
            'roomId': this._roomId,
            'uid': this._uid,
            'sdp' : offerInfo.offSdp
        }
        var respData;

        try {
            console.log("send publish request:", data);
            respData = await this.ws.request('publish', data);
        } catch (error) {
            console.log("send publish message exception:", error)
            throw error
        }
        console.log("Publish response message:", respData);

        var answerSdp = respData['sdp'];
        var peerConnectionId = respData['pcid'];

        sendCameraPc.SetId(peerConnectionId);

        await sendCameraPc.SetSendAnswerSdp(answerSdp);

        var answerSdpObj = SdpTransformer.parse(answerSdp);
        for (const item of answerSdpObj.media)
        {
            if (item.type == 'video')
            {
                this._cameraVideoMid = item.mid;
            }
            else if (item.type == 'audio')
            {
                this._cameraAudioMid = item.mid;
            }
            else
            {
                throw new Error("the sdp type is unkown:", item.type);
            }
        }
        this._sendPCMap.set(peerConnectionId, sendCameraPc);
        return;
    }

    async UnPublishCamera({videoDisable, audioDisable})
    {
        if (!this._connected)
        {
            throw new Error('websocket is not ready');
        }

        if (!this._cameraStream)
        {
            throw new Error('camera does not init');
        }

        if (!videoDisable && !audioDisable)
        {
            throw new Error('video and audio are not disable');
        }

        var removeMids = [];
        if (videoDisable)
        {
            removeMids.push(this._cameraVideoMid);
        }
        if (audioDisable)
        {
            removeMids.push(this._cameraAudioMid);
        }

        var sendPC = null;

        for (var pc of this._sendPCMap.values())
        {
            if (pc.GetType() == 'camera')
            {
                sendPC = pc;
                break;
            }
        }
        if (sendPC == null)
        {
            throw new Error("fail to find camera");
        }
        sendPC.removeSendTrack(removeMids);

        sendPC.ClosePC();

        this._sendPCMap.delete(sendPC.GetId());

        //send unpublish request
        var data = {
            'roomId': this._roomId,
            'uid': this._uid,
            'pcid' : sendPC.GetId()
        }

        var respData;
        try {
            console.log("unpublish request: ", data);
            respData = await this.ws.request('unpublish', data);
        } catch (error) {
            console.log("send unpublish message exception:", error)
            throw error
        }
        console.log("UnPublish response message:", respData);

        return respData;
    }

    _wsRegistEvent(resolve, reject)
    {
        this.ws.on('open', () =>
        {
            this._connected = true;
            this._closed = false;
            resolve(0);
        });
        
        this.ws.on('close', () => 
        {
            this._connected = false;
            this._closed = true;
            reject(new Error('protoo close'));
        });

        this.ws.on('error', (err) =>
        {
            this._connected = false;
            this._closed = true;
            reject(err);
        });

        this.ws.on('notification', (info) =>
        {
            try {
                console.log("notification info:", info);
                if (info.method == 'userin')
                {
                    var remoteUid = info.data['uid'];
                    var remoteUser = new UserInfo({roomId: this._roomId, uid:remoteUid});
                    this._remoteUsers.set(remoteUid, remoteUser);
                }
                this.safeEmit(info.method, info.data);
            } catch (error) {
                console.log("notify error:", error);
            }
            
        });
    }

    async Subscribe(remoteUid, remotePcId, publishers)
    {
        if (!this._connected)
        {
            throw new Error('websocket is not ready');
        }

        var hasUid = this._remoteUsers.has(remoteUid);
        if (!hasUid)
        {
            throw new Error('remote uid has not exist:' + remoteUid);
        }
        var remoteUser = this._remoteUsers.get(remoteUid);

        console.log("start subscribe remote user:", remoteUser, "publishers:", publishers);

        var recvPC = new PCManager();
        recvPC.CreatePeerConnection('recv');
        recvPC.SetRemoteUid(remoteUid);

        for (const info of publishers) {
            recvPC.AddSubscriberMedia(info);
        }

        var offerSdp = await recvPC.GetSubscribeOfferSdp();
        var offerSdpObj = SdpTransformer.parse(offerSdp);

        console.log("subscriber offer sdp:", offerSdpObj);
        console.log("update publishers:", publishers);

        var respData = null;
        var data = {
            'roomId': this._roomId,
            'uid': this._uid,
            'remoteUid': remoteUid,
            'remotePcId': remotePcId,
            'publishers': publishers,
            'sdp' : offerSdp
        }

        try {
            console.log("subscribe request: ", data);
            respData = await this.ws.request('subscribe', data);
        } catch (error) {
            console.log("send subscribe message exception:", error)
            throw error
        }
        console.log("subscribe response message:", respData);

        var respSdp = respData.sdp;
        var pcid    = respData.pcid;
        var respSdpJson = SdpTransformer.parse(respSdp);

        console.log("subscribe response json sdp:", JSON.stringify(respSdpJson));
        recvPC.SetRemoteSubscriberSdp(respSdp);

        var trackList = [];
        for (const mediaInfo of publishers)
        {
            console.log("subscribe is waiting track ready...");
            var newTrack = await new Promise(async (resolve, reject) =>
            {
                recvPC.on('newTrack', (track) => {
                    console.log("rtc receive new track:", track);
                    if (track != null) {
                        resolve(track);
                    } else {
                        reject(track);
                    }
                });
            });
            if (newTrack != null)
            {
                trackList.push(newTrack);
            }
        }
        console.log("receive new track list:", trackList);

        var mediaStream = remoteUser.CreateMediaStream();

        for (const track of trackList)
        {
            console.log("remote user:", remoteUser, "add new track:", track);
            mediaStream.addTrack(track);
        }

        console.log("set subscribe pcid:", pcid, "publishers:", publishers);
        recvPC.SetSubscribeInfo(pcid, publishers)
        recvPC.SetId(pcid);
        this._recvPCMap.set(pcid, recvPC);
        return mediaStream;
    }

    async UnSubscribe(remoteUid, publisers)
    {
        if (!this._connected)
        {
            throw new Error('websocket is not ready');
        }

        var hasUid = this._remoteUsers.has(remoteUid);
        if (!hasUid)
        {
            throw new Error('remote uid has not exist:' + remoteUid);
        }
        var remoteUser = this._remoteUsers.get(remoteUid);
        var pcid = '';

        console.log("start unsubscribe remote user:", remoteUser, "publishers:", publisers);

        for (var [keyPCid, recvPC] of this._recvPCMap)
        {
            pcid = recvPC.GetSubscribePcId(publisers);
            if (pcid != undefined && pcid.length > 0)
            {
                break;
            }
        }
        if (pcid == undefined || pcid.length == '')
        {
            console.log("fail to get peer connection id:", pcid);
            throw new Error("fail to get peer connection id");
        }
        
        for (const info of publisers) {
            recvPC.RemoveSubscriberMedia(info);
        }
        recvPC.SetRemoteUnSubscriberSdp();
        recvPC.ClosePC();
        remoteUser.CloseMediaStream();
        
        var data = {
            'uid': this._uid,
            'remoteUid': remoteUid,
            'pcid': pcid,
            'publishers': publisers
        }
        var respData;

        console.log("request unsubscribe data:", data);
        try {
            respData = await this.ws.request('unsubscribe', data);
        } catch (error) {
            console.log('unsubscribe error:', error);
            throw error;
        }
        console.log('unsubscribe return data:', respData);

    }
};

module.exports = Client;