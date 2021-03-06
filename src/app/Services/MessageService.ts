import { Injectable } from '@angular/core';
import { EventType } from '../Models/Events/EventType';
import { AiurEvent } from '../Models/Events/AiurEvent';
import Swal from 'sweetalert2';
import { NewMessageEvent } from '../Models/Events/NewMessageEvent';
import { Conversation } from '../Models/Conversation';
import { Message } from '../Models/Message';
import { ConversationApiService } from './Api/ConversationApiService';
import { map } from 'rxjs/operators';
import { UploadService } from './UploadService';
import { KahlaUser } from '../Models/KahlaUser';
import { AES, enc } from 'crypto-js';
import { CacheService } from './CacheService';
import * as he from 'he';
import Autolinker from 'autolinker';
import { Values } from '../values';
import { ElectronService } from 'ngx-electron';
import { TimerUpdatedEvent } from '../Models/Events/TimerUpdatedEvent';
import { TimerService } from './TimerService';
import { FriendDeletedEvent } from '../Models/Events/FriendDeletedEvent';
import { NewFriendRequestEvent } from '../Models/Events/NewFriendRequestEvent';
import { FriendsChangedEvent } from '../Models/Events/FriendsChangedEvent';
import { Router } from '@angular/router';
import { UserGroupRelation } from '../Models/UserGroupRelation';
import { SomeoneLeftEvent } from '../Models/Events/SomeoneLeftEvent';
import { NewMemberEvent } from '../Models/Events/NewMemberEvent';
import { GroupConversation } from '../Models/GroupConversation';
import { DissolveEvent } from '../Models/Events/DissolveEvent';
import { HomeService } from './HomeService';
import { GroupsApiService } from './Api/GroupsApiService';
import { FriendsApiService } from './Api/FriendsApiService';
import { ProbeService } from './ProbeService';
import { ThemeService } from './ThemeService';
import { FilesApiService } from './Api/FilesApiService';
import { FileType } from '../Models/FileType';
import { MessageFileRef } from '../Models/MessageFileRef';

@Injectable({
    providedIn: 'root'
})

export class MessageService {
    public conversation: Conversation;
    public localMessages: Message[] = [];
    public rawMessages: Message[] = [];
    public noMoreMessages = false;
    public loadingMore = false;
    public belowWindowPercent = 0;
    public newMessages = false;
    private oldScrollHeight: number;
    public maxImageWidth = 0;
    public videoHeight = 0;
    private userColors = new Map<string, string>();
    public groupConversation = false;
    public sysNotifyText: string;
    public sysNotifyShown: boolean;
    public messageLoading = false;
    public fileAccessToken: string;
    public accessTokenUpdateSchedule: any;
    public shareRef: MessageFileRef;

    constructor(
        private conversationApiService: ConversationApiService,
        private uploadService: UploadService,
        private filesApiService: FilesApiService,
        private cacheService: CacheService,
        private _electronService: ElectronService,
        private timerService: TimerService,
        private router: Router,
        private homeService: HomeService,
        private groupsApiService: GroupsApiService,
        private friendsApiService: FriendsApiService,
        private probeService: ProbeService,
        private themeService: ThemeService,
    ) {
    }

    public OnMessage(data: MessageEvent) {
        const ev = JSON.parse(data.data) as AiurEvent;
        const fireAlert = !localStorage.getItem('deviceID');
        switch (ev.type) {
            case EventType.NewMessage: {
                const evt = ev as NewMessageEvent;
                const conversationCacheIndex = this.cacheService.cachedData.conversations
                    .findIndex(x => x.conversationId === evt.message.conversationId);
                if (conversationCacheIndex !== -1) {
                    const conversationCache = this.cacheService.cachedData.conversations[conversationCacheIndex];
                    const latestMsg = Object.assign({}, evt.message);
                    latestMsg.content = this.cacheService.modifyMessage(
                        AES.decrypt(evt.message.content, evt.aesKey).toString(enc.Utf8));
                    conversationCache.latestMessage = latestMsg;
                    if (!this.conversation || this.conversation.id !== evt.message.conversationId) {
                        conversationCache.unReadAmount++;
                        if (evt.mentioned) {
                            conversationCache.someoneAtMe = true;
                        }
                    } else {
                        conversationCache.unReadAmount = 0; // clear red dot when something went wrong
                    }
                    // move the new conversation to the top
                    this.cacheService.cachedData.conversations.splice(conversationCacheIndex, 1);
                    this.cacheService.cachedData.conversations.splice(0, 0, conversationCache);
                    this.cacheService.saveCache();
                    this.cacheService.updateTotalUnread();
                } else {
                    if (this.homeService.wideScreenEnabled || this.router.isActive('home', false)) {
                        setTimeout(() => this.cacheService.updateConversation(), 1000);
                    }
                }
                if (this.conversation && this.conversation.id === evt.message.conversationId
                    && this.localMessages.findIndex(t => t.id === evt.message.id) === -1) {
                    if (evt.previousMessageId === this.rawMessages[this.rawMessages.length - 1].id ||
                        evt.previousMessageId === '00000000-0000-0000-0000-000000000000') {
                        this.rawMessages.push(evt.message);
                        this.localMessages.push(this.modifyMessage(Object.assign({}, evt.message)));
                        this.reorderLocalMessages();
                        this.updateAtLink();
                        this.conversationApiService.GetMessage(this.conversation.id, null, 0).subscribe();
                        this.saveMessage();
                    } else { // lost some message.
                        this.getMessages(0, this.conversation.id, null, 15);
                    }
                    if (this.belowWindowPercent <= 0.2) {
                        setTimeout(() => {
                            this.uploadService.scrollBottom(true);
                        }, 0);
                    }
                    if (!document.hasFocus()) {
                        this.showNotification(evt);
                    }
                } else {
                    this.showNotification(evt);
                }
                break;
            }
            case EventType.NewFriendRequest: {
                if (fireAlert && (<NewFriendRequestEvent>ev).request.creatorId !== this.cacheService.cachedData.me.id) {
                    Swal.fire('Friend request', 'New friend request from ' + (<NewFriendRequestEvent>ev).request.creator.nickName, 'info');
                }
                this.cacheService.updateRequests();
                break;
            }
            case EventType.FriendDeletedEvent: {
                if (fireAlert && (<FriendDeletedEvent>ev).trigger.id !== this.cacheService.cachedData.me.id) {
                    Swal.fire('Were deleted', 'You were deleted by ' + (<FriendDeletedEvent>ev).trigger.nickName, 'info');
                }
                this.cacheService.updateConversation();
                this.cacheService.updateFriends();
                break;
            }
            case EventType.FriendsChangedEvent: {
                const evt = <FriendsChangedEvent>ev;
                this.cacheService.updateRequests();
                if (evt.result) {
                    if (fireAlert && evt.request.creatorId === this.cacheService.cachedData.me.id) {
                        Swal.fire('Friend request accepted', 'You and ' + evt.createdConversation.displayName +
                            ' are now friends!', 'success');
                    }
                    this.cacheService.updateConversation();
                    this.cacheService.updateFriends();
                    if (this.router.isActive(`/user/${evt.request.targetId}`, false)) {
                        this.router.navigate(['/talking', evt.createdConversation.id]);
                    }
                } else {
                    if (fireAlert && evt.request.creatorId === this.cacheService.cachedData.me.id) {
                        Swal.fire('Friend request rejected', `${evt.request.target.nickName} rejected your friend request.`, 'info');
                    }
                }
                break;
            }
            case EventType.TimerUpdatedEvent: {
                const evt = ev as TimerUpdatedEvent;
                if (this.conversation && this.conversation.id === evt.conversationId) {
                    this.conversation.maxLiveSeconds = evt.newTimer;
                    this.timerService.updateDestructTime(evt.newTimer);
                    Swal.fire('Self-destruct timer updated!', 'Your current message life time is: ' +
                        this.timerService.destructTime, 'info');
                    this.cleanMessageByTimer();
                }
                break;
            }
            case EventType.NewMemberEvent: {
                const evt = ev as NewMemberEvent;
                if (this.conversation && this.conversation.id === evt.conversationId) {
                    this.conversationApiService.ConversationDetail(evt.conversationId)
                        .subscribe(updated => {
                            this.conversation = updated.value;
                        });
                    this.displaySysNotify(`${evt.newMember.nickName} joined the group.`);
                }
                break;
            }
            case EventType.SomeoneLeftEvent: {
                const evt = ev as SomeoneLeftEvent;
                const current = this.conversation && this.conversation.id === evt.conversationId && this.router.isActive('talking', false);
                if (evt.leftUser.id === this.cacheService.cachedData.me.id) {
                    Swal.fire('Oops, you have been kicked.',
                        `You have been kicked by the owner of group ${this.cacheService.cachedData.conversations
                            .find(x => x.conversationId === evt.conversationId).displayName}.`,
                        'warning');
                    this.cacheService.updateFriends();
                    this.cacheService.updateConversation();
                    if (current) {
                        this.router.navigate(['/home']);
                    }
                } else if (current) {
                    this.conversation.users.splice(this.conversation.users.findIndex(x => x.user.id === evt.leftUser.id));
                    this.displaySysNotify(`${evt.leftUser.nickName} left the group.`);
                }
                break;
            }
            case EventType.DissolveEvent: {
                if (this.conversation && this.conversation.id === (<DissolveEvent>ev).conversationId) {
                    Swal.fire('The group has been dissolved!',
                        `Group ${this.conversation.displayName} has been dissolved by the owner!`,
                        'warning');
                    this.router.navigate(['/home']);
                }
                this.cacheService.updateFriends();
                this.cacheService.updateConversation();
                break;
            }
            case EventType.GroupJoinedEvent: {
                this.cacheService.updateFriends();
                this.cacheService.updateConversation();
                break;
            }
            default:
                break;
        }
    }

    public displaySysNotify(message: string) {
        this.sysNotifyText = message;
        if (!this.sysNotifyShown) {
            this.sysNotifyShown = true;
            setTimeout(() => {
                this.sysNotifyShown = false;
            }, 10000);
        }
    }

    public getMessages(unread: number, id: number, skipFrom: string, take: number) {
        this.messageLoading = true;
        this.localMessages = this.localMessages.filter(t => !t.local);
        this.conversationApiService.GetMessage(id, skipFrom, take)
            .pipe(
                map(t => t.items)
            )
            .subscribe(messages => {
                if (!this.conversation || this.conversation.id !== id) {
                    return;
                }
                const modifiedMsg = messages.map(t => this.modifyMessage(Object.assign({}, t)));
                if (messages.length < take) {
                    this.noMoreMessages = true;
                }
                if (this.localMessages.length > 0 && messages.length > 0) {
                    this.newMessages = this.cacheService.cachedData.me &&
                        messages[messages.length - 1].senderId !== this.cacheService.cachedData.me.id &&
                        take === 1 && this.belowWindowPercent > 0;
                }
                // if (this.localMessages.length > 1000) {
                //     this.localMessages.splice(0, 500);
                // }
                // Load new
                if (!skipFrom) {
                    if (this.localMessages.length > 0 && messages.length > 0) {
                        const index = this.rawMessages.findIndex(t => t.id === messages[0].id);
                        if (index === -1) {
                            this.localMessages = modifiedMsg;
                            this.rawMessages = messages;
                        } else {
                            const deleteCount = this.rawMessages.length - index;
                            this.localMessages.splice(index, deleteCount, ...modifiedMsg);
                            this.rawMessages.splice(index, deleteCount, ...messages);
                        }
                    } else {
                        this.localMessages = modifiedMsg;
                        this.rawMessages = messages;
                    }
                } else { // load more
                    this.localMessages.unshift(...modifiedMsg);
                    this.rawMessages.unshift(...messages);
                }
                if (unread === 0) {
                    setTimeout(() => {
                        this.uploadService.scrollBottom(true);
                    }, 0);
                } else if (unread === -1) { // load more
                    this.loadingMore = false;
                    setTimeout(() => {
                        window.scroll(0, document.documentElement.scrollHeight - this.oldScrollHeight);
                    }, 0);
                } else {
                    if (unread > 1) {
                        // add a last read bar
                        this.localMessages[this.localMessages.length - unread].lastRead = true;
                        this.localMessages[this.localMessages.length - unread].groupWithPrevious = false;
                    }
                    setTimeout(() => {
                        const lis = document.querySelector('#messageList').querySelectorAll('li');
                        window.scrollTo({
                            top: lis[lis.length - unread].offsetTop,
                            left: 0,
                            behavior: 'smooth'
                        });
                    }, 0);
                }
                this.updateAtLink();
                this.saveMessage();
                // clear red dot if necessary
                const listItem = this.cacheService.cachedData.conversations.find(t => t.conversationId === this.conversation.id);
                if (listItem) {
                    listItem.unReadAmount = 0;
                }
                this.cacheService.updateTotalUnread();
                this.showFailedMessages();
                this.reorderLocalMessages();
                this.messageLoading = false;
            });
    }

    public updateBelowWindowPercent(): void {
        this.belowWindowPercent = (document.documentElement.scrollHeight - window.scrollY
            - document.documentElement.clientHeight) / document.documentElement.clientHeight;
    }

    public loadMore(): void {
        if (!this.noMoreMessages) {
            this.loadingMore = true;
            this.oldScrollHeight = document.documentElement.scrollHeight;
            this.getMessages(-1, this.conversation.id, this.localMessages[0].id, 15);
        }
    }

    public updateFriends(): void {
        this.cacheService.updateFriends();
        this.cacheService.updateRequests();
    }

    public updateMaxImageWidth(): void {
        this.maxImageWidth = Math.floor((this.homeService.contentWrapper.clientWidth - 40) * 0.7 - 20 - 2);
        this.videoHeight = Math.max(Math.floor(Math.min(this.maxImageWidth * 9 / 21, 400)), 170);
    }

    public resetVariables(): void {
        this.conversation = null;
        this.localMessages = [];
        this.rawMessages = [];
        this.noMoreMessages = false;
        this.loadingMore = false;
        this.belowWindowPercent = 0;
        this.newMessages = false;
        this.oldScrollHeight = 0;
        this.maxImageWidth = 0;
        this.userColors.clear();
        this.groupConversation = false;
        this.fileAccessToken = null;
        if (this.accessTokenUpdateSchedule) {
            clearInterval(this.accessTokenUpdateSchedule);
            this.accessTokenUpdateSchedule = null;
        }
    }

    private showNotification(event: NewMessageEvent): void {
        if (!event.muted &&
            event.message.sender.id !== this.cacheService.cachedData.me.id &&
            this._electronService.isElectronApp &&
            localStorage.getItem('setting-electronNotify') !== 'false') {
            event.message.content = AES.decrypt(event.message.content, event.aesKey).toString(enc.Utf8);
            event.message.content = this.cacheService.modifyMessage(event.message.content);
            const notify = new Notification(event.message.sender.nickName, {
                body: event.message.content,
                icon: this.probeService.encodeProbeFileUrl(event.message.sender.iconFilePath)
            });
            notify.onclick = function (clickEvent) {
                clickEvent.preventDefault();
                window.focus();
            };
        }
    }

    public getRandomColor(darkColor: boolean): string {
        let r = Math.floor(Math.random() * 128);
        let g = Math.floor(Math.random() * 128);
        let b = Math.floor(Math.random() * 128);
        if (!darkColor) {
            r = Math.max(r + 127, 200);
            g = Math.max(g + 127, 200);
            b = Math.max(b + 127, 200);
        }
        return `rgb(${r}, ${g}, ${b})`;
    }

    public getGroupColor(message: Message): string {
        if (!this.userColors.has(message.senderId)) {
            this.userColors.set(message.senderId, this.getRandomColor(!this.themeService.IsDarkTheme()));
        }
        return this.userColors.get(message.senderId);
    }

    public searchUser(nickName: string, getMessage: boolean): Array<KahlaUser> {
        if (typeof this.conversation.users !== 'undefined') {
            if (nickName.length === 0 && !getMessage) {
                return this.conversation.users.map(x => x.user);
            } else {
                const matchedUsers = [];
                this.conversation.users.forEach((value: UserGroupRelation) => {
                    if (!getMessage && value.user.nickName.toLowerCase().replace(/ /g, '').includes(nickName.toLowerCase())) {
                        matchedUsers.push(value.user);
                    } else if (getMessage && value.user.nickName.toLowerCase().replace(/ /g, '') === nickName.toLowerCase()) {
                        matchedUsers.push(value.user);
                    }
                });
                return matchedUsers;
            }
        }
        return [];
    }

    public getAtIDs(message: string): Array<string> {
        const atUsers = [];
        const newMessageArry = message.split(' ');
        message.split(' ').forEach((s, index) => {
            if (s.length > 0 && s[0] === '@') {
                const searchResults = this.searchUser(he.decode(s.slice(1)), true);
                if (searchResults.length > 0) {
                    atUsers.push(searchResults[0].id);
                    newMessageArry[index] = `<a class="chat-inline-link atLink"
                        href="/user/${searchResults[0].id}">${newMessageArry[index]}</a>`;
                }
            }
        });
        atUsers.unshift(newMessageArry.join(' '));
        return atUsers;
    }

    public checkEmoji(text: string): boolean {
        if (text.length > 2) {
            return false;
        }
        const regex = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
        return regex.test(text);
    }

    public checkOwner(id?: string): boolean {
        if (this.conversation && this.cacheService.cachedData.me) {
            if (this.conversation.discriminator === 'GroupConversation') {
                return (<GroupConversation>this.conversation).ownerId === (id ? id : this.cacheService.cachedData.me.id);
            } else {
                return true;
            }
        }
        return false;
    }

    public modifyMessage(t: Message, decrypt: boolean = true): Message {
        if (decrypt) {
            try {
                t.content = AES.decrypt(t.content, this.conversation.aesKey).toString(enc.Utf8);
            } catch (error) {
                t.content = '';
            }
        }
        t.contentRaw = t.content;
        t.sendTimeDate = new Date(t.sendTime);
        t.timeStamp = t.sendTimeDate.getTime();
        const isFile = t.content.match(/^\[(video|img|file|audio)](.+)$/);
        if (isFile) {
            if (isFile[1] === 'img') {
                const imgSplit = isFile[2].split('|');
                if (imgSplit.length < 3) {
                    t.content = 'Invalid';
                    return t;
                }
                const imageWidth = Number(imgSplit[1]),
                    imageHeight = Number(imgSplit[2]);
                const ratio = imageHeight / imageWidth;
                const realMaxWidth = Math.max(Math.min(this.maxImageWidth, Math.floor(500 / ratio)),
                    Math.min(this.maxImageWidth, 100)); // for too long image, just cut half of it
                t.fileRef = {
                    imgWidth: imageWidth,
                    imgHeight: imageHeight,
                    imgDisplayWidth: imageWidth,
                    imgDisplayHeight: imageHeight,
                    fileType: FileType.Image,
                    filePath: imgSplit[0]
                } as MessageFileRef;
                if (realMaxWidth < imageWidth) {
                    t.fileRef.imgDisplayWidth = realMaxWidth;
                    t.fileRef.imgDisplayHeight = Math.floor(realMaxWidth * ratio);
                }
            } else if (isFile[1] === 'file') {
                const fileSplit = isFile[2].split('|');
                if (fileSplit.length < 3) {
                    t.content = 'Invalid';
                    return t;
                }
                t.fileRef = {
                    filePath: fileSplit[0],
                    fileName: fileSplit[1],
                    fileSize: fileSplit[2],
                    fileType: FileType.File
                } as MessageFileRef;
            } else {
                if (!isFile[2]) {
                    t.content = 'Invalid';
                    return t;
                }
                t.fileRef = {
                    filePath: isFile[2],
                    fileType: isFile[1] === 'video' ? FileType.Video : FileType.Audio
                } as MessageFileRef;
            }
        } else if (t.content.startsWith('[group]')) {
            const groupId = Number(t.content.substring(7));
            t.content = `[share]-|Loading...| |${Values.loadingImgURL}`;
            this.groupsApiService.GroupSummary(groupId).subscribe(p => {
                if (p.value) {
                    t.content = `[share]${p.value.id}|${p.value.name.replace(/\|/g, '')}|` +
                        `${p.value.hasPassword ? 'Private' : 'Public'}|${this.probeService.encodeProbeFileUrl(p.value.imagePath)}`;
                    t.relatedData = p.value;
                } else {
                    t.content = 'Invalid Group';
                }
            });

        } else if (t.content.startsWith('[user]')) {
            const userId = t.content.substring(6);
            t.content = `[share]-|Loading...| |${Values.loadingImgURL}`;
            this.friendsApiService.UserDetail(userId).subscribe(p => {
                if (p.user) {
                    t.content = `[share]${p.user.id}|${p.user.nickName.replace(/\|/g, '')}|` +
                        `${p.user.bio ? p.user.bio.replace(/\|/g, ' ') : ' '}|${this.probeService.encodeProbeFileUrl(p.user.iconFilePath)}`;
                    t.relatedData = p.user;
                } else {
                    t.content = 'Invalid User';
                }
            });
        } else {
            t.isEmoji = this.checkEmoji(t.content);
            t.content = he.encode(t.content);
            t.content = Autolinker.link(t.content, {
                stripPrefix: false,
                className: 'chat-inline-link'
            });
            t.content = this.getAtIDs(t.content)[0];
        }
        return t;
    }

    public reorderLocalMessages() {
        this.localMessages.sort((a, b) => a.timeStamp - b.timeStamp);
    }

    public updateAtLink() {
        setTimeout(() => {
            const links = document.getElementsByClassName('atLink');
            for (let i = 0; i < links.length; i++) {
                (<HTMLAnchorElement>links.item(i)).onclick = (ev: MouseEvent) => {
                    ev.preventDefault();
                    // noinspection JSIgnoredPromiseFromCall
                    this.router.navigateByUrl(links.item(i).getAttribute('href'));
                };
            }
        }, 0);
    }

    public saveMessage(): void {
        localStorage.setItem(`cache-log-${this.conversation.id}`, JSON.stringify(this.rawMessages));
    }

    public initMessage(conversationId: number): void {
        const json = localStorage.getItem(`cache-log-${conversationId}`);
        if (json) {
            this.rawMessages = JSON.parse(json);
        }
        this.localMessages = this.rawMessages.map(t => this.modifyMessage(Object.assign({}, t)));
        this.showFailedMessages();
        this.reorderLocalMessages();
        this.updateAtLink();
        this.updateAccessToken();
        this.accessTokenUpdateSchedule = setInterval(() => this.updateAccessToken(), 1190000); // 20min - 10s
        setTimeout(() => this.uploadService.scrollBottom(false), 0);
    }

    public cleanMessageByTimer(): void {
        if (!this.conversation) {
            return;
        }
        const firstIndex = this.rawMessages.findIndex(t => {
            const timeStamp = new Date(t.sendTime).getTime();
            return timeStamp + this.conversation.maxLiveSeconds * 1000 >= Date.now();
        });
        if (firstIndex === 0) {
            return;
        } else if (firstIndex === -1) {
            this.rawMessages = [];
            this.localMessages = [];
        } else {
            if (this.localMessages.length === this.rawMessages.length) {
                this.localMessages = this.localMessages.splice(0, firstIndex);
            }
            this.rawMessages = this.rawMessages.splice(0, firstIndex);
        }
        this.saveMessage();
    }

    public showFailedMessages(): void {
        const unsentMessages = new Map(JSON.parse(localStorage.getItem('unsentMessages')));
        this.localMessages = this.localMessages.filter(m => !m.resend);
        if (unsentMessages.has(this.conversation.id)) {
            (<Array<Message>>(unsentMessages.get(this.conversation.id))).forEach((message) => {
                message.resend = true;
                message.sendTimeDate = new Date(message.sendTime);
                this.localMessages.push(message);
            }, this);
        }
    }

    public upperFloorImageSize(width: number) {
        return Math.pow(2, Math.ceil(Math.log2(width)));
    }

    public updateAccessToken() {
        this.filesApiService.InitFileAccess(this.conversation.id).subscribe(t => {
            this.fileAccessToken = encodeURIComponent(t.value);
        });
    }

    public insertMessage(p: Message) {
        if (this.rawMessages.find(t => t.id === p.id)) {
            return;
        }
        this.rawMessages.push(p);
        this.localMessages.push(this.modifyMessage(Object.assign({}, p)));
        this.reorderLocalMessages();
        this.updateAtLink();
        this.saveMessage();
    }
}
